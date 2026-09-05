/**
 * Commandcodex CLI transport adapter — drives the OFFICIAL `command-code` CLI in
 * headless mode (`cmd -p --output-format json`). This is the sanctioned automation
 * surface for plans without Provider API access (their docs: "Run Command Code in
 * headless mode for CI/CD pipelines and automation workflows", auth via the
 * COMMAND_CODE_API_KEY env var). Every upstream request is the real CLI.
 *
 * Codex's Responses context is flattened into one prompt. Codex tools are described in
 * the prompt with an XML call protocol; the model's tool calls arrive as <ccx-tool>…
 * </ccx-tool> tags inside the text stream, which this adapter buffers into proper
 * tool_call events instead of leaking raw tags to the user.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMeta, ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, CodexContentPart, CodexMessage, CodexParsedRequest, CodexTool } from "../types";
import { errorText } from "../lib/errors";

/** Exit codes from https://commandcode.ai/docs/headless */
const EXIT = {
  AUTH: 3,
  PERMISSION: 4,
  RATE_LIMIT: 5,
  NETWORK: 6,
  SERVER: 7,
  MAX_TURNS: 8,
  NO_RESPONSE: 9,
  CREDITS: 10,
} as const;

const CLI_DEFAULT = "cmd";

interface CliOptions {
  /** Binary name or absolute path of the command-code CLI. */
  cliPath?: string;
  /** Extra env for the child (COMMAND_CODE_API_KEY is injected by the caller). */
  cwd?: string;
}

interface NdjsonEvent {
  type: "event" | "result";
  event?: {
    type: string;
    delta?: string;
    name?: string;
    input?: unknown;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    stopReason?: string;
    result?: {
      finalText?: string;
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
  };
  // result frames
  subtype?: "success" | "error" | "max_turns";
  usage?: { inputTokens?: number; outputTokens?: number };
  durationMs?: number;
  finalText?: string;
  stopReason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool protocol (embedded in the prompt, parsed out of the text stream)
// ---------------------------------------------------------------------------

const TOOL_OPEN = "<ccx-tool>";
const TOOL_CLOSE = "</ccx-tool>";

export const TOOL_PROTOCOL_INSTRUCTIONS = [
  "# Tool calling protocol",
  "",
  "You can call tools that were provided in this conversation by the orchestrating agent.",
  "When you decide to call a tool, emit EXACTLY this XML tag on its own line and then STOP",
  "your reply immediately (no text after the closing tag):",
  "",
  TOOL_OPEN,
  '{"name": "<tool-name>", "arguments": {…json arguments…}}',
  TOOL_CLOSE,
  "",
  "Rules:",
  "- The tag content MUST be a single valid JSON object with keys `name` and `arguments`.",
  "- Emit at most ONE tool tag per reply, and NOTHING else in that reply (no prose, no markdown fences around it).",
  "- Do not simulate, describe, or narrate tool results. Emit the tag and stop; the orchestrator will run the tool and send you the result.",
  "- If no tool is needed, answer in plain text.",
].join("\n");

export function formatToolCatalog(tools: CodexTool[]): string {
  if (tools.length === 0) return "";
  const lines = ["# Available tools", ""];
  for (const tool of tools) {
    const name = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
    lines.push(`## ${name}`);
    if (tool.description) lines.push(tool.description);
    lines.push("Parameters (JSON schema):");
    lines.push("```json");
    lines.push(JSON.stringify(tool.parameters ?? { type: "object", properties: {} }));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

export interface ParsedToolTag {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

/** Extract the first complete <ccx-tool> tag from `text`; returns it and the residual text. */
export function extractToolTag(text: string): { tag: ParsedToolTag | null; rest: string } {
  const start = text.indexOf(TOOL_OPEN);
  if (start === -1) return { tag: null, rest: text };
  const end = text.indexOf(TOOL_CLOSE, start);
  if (end === -1) return { tag: null, rest: text }; // incomplete — wait for more deltas
  const before = text.slice(0, start);
  const inner = text.slice(start + TOOL_OPEN.length, end).trim();
  const after = text.slice(end + TOOL_CLOSE.length);
  try {
    const parsed = JSON.parse(inner) as { name?: unknown; arguments?: unknown };
    if (typeof parsed.name === "string" && parsed.arguments !== undefined) {
      return {
        tag: { name: parsed.name, arguments: (parsed.arguments ?? {}) as Record<string, unknown>, raw: before },
        rest: after,
      };
    }
  } catch {
    // fall through: malformed tag degrades to plain text below
  }
  // Malformed JSON inside a tag — treat the whole tag as plain text (minus the markers).
  return { tag: null, rest: `${before}${inner}${after}` };
}

/** True when the buffer ends inside an (as-yet-unclosed) tool tag. */
export function hasOpenToolTag(text: string): boolean {
  const start = text.lastIndexOf(TOOL_OPEN);
  if (start === -1) return false;
  return text.indexOf(TOOL_CLOSE, start) === -1;
}

// ---------------------------------------------------------------------------
// Prompt flattening
// ---------------------------------------------------------------------------

export function flattenContent(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text") out.push(part.text);
    else out.push(`[image attached: ${part.imageUrl.slice(0, 64)}…]`);
  }
  return out.join("\n");
}

export function flattenMessages(messages: CodexMessage[]): string {
  const out: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "user":
        out.push(`<user>\n${flattenContent(message.content)}\n</user>`);
        break;
      case "developer":
        out.push(`<orchestrator>\n${flattenContent(message.content)}\n</orchestrator>`);
        break;
      case "agentMessage":
        out.push(`<message from="${message.author ?? "agent"}">\n${flattenContent(message.content)}\n</message>`);
        break;
      case "assistant": {
        const text = message.content
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map(part => part.text)
          .join("");
        const calls = message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall");
        if (text) out.push(`<assistant>\n${text}\n</assistant>`);
        for (const call of calls) {
          const name = call.namespace ? `${call.namespace}__${call.name}` : call.name;
          out.push(`<assistant_tool_call>\n{"name": "${name}", "arguments": ${JSON.stringify(call.arguments ?? {})}}\n</assistant_tool_call>`);
        }
        break;
      }
      case "toolResult":
        out.push(`<tool_result tool="${message.toolName}" for="${message.toolCallId}">\n${flattenContent(message.content)}\n</tool_result>`);
        break;
    }
  }
  return out.join("\n\n");
}

export function buildCliPrompt(parsed: CodexParsedRequest): string {
  const sections: string[] = [];
  const system = (parsed.context.systemPrompt ?? []).join("\n\n").trim();
  if (system) sections.push(`<system>\n${system}\n</system>`);
  const tools = parsed.context.tools ?? [];
  if (tools.length > 0) {
    sections.push(formatToolCatalog(tools));
    sections.push(TOOL_PROTOCOL_INSTRUCTIONS);
  }
  const conversation = flattenMessages(parsed.context.messages);
  if (conversation) sections.push(`<conversation>\n${conversation}\n</conversation>`);
  sections.push("Respond to the latest user request now, following the protocol above.");
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Exit-code → AdapterEvent mapping
// ---------------------------------------------------------------------------

export function errorEventForExit(code: number, stderr: string): AdapterEvent {
  const detail = stderr.trim().split("\n").filter(Boolean).pop() ?? `cli exited with code ${code}`;
  switch (code) {
    case EXIT.AUTH:
      return { type: "error", message: `CLI not authenticated: ${detail}`, status: 401, errorType: "authentication_error", code: "cli_auth" };
    case EXIT.RATE_LIMIT:
      return { type: "error", message: `rate limited: ${detail}`, status: 429, errorType: "rate_limit_error", retryable: true };
    case EXIT.CREDITS:
      return { type: "error", message: `insufficient credits: ${detail}`, status: 402, errorType: "insufficient_credits" };
    case EXIT.SERVER:
      return { type: "error", message: `upstream server error: ${detail}`, status: 502, errorType: "server_error", retryable: true };
    case EXIT.NETWORK:
      return { type: "error", message: `network failure: ${detail}`, status: 503, errorType: "connection_error", retryable: true };
    case EXIT.MAX_TURNS:
      return { type: "incomplete", reason: "cli_max_turns", message: detail };
    case EXIT.NO_RESPONSE:
      return { type: "error", message: `model produced no response: ${detail}`, status: 502, errorType: "server_error" };
    case EXIT.PERMISSION:
      return { type: "error", message: `permission denied: ${detail}`, status: 403, errorType: "permission_error" };
    default:
      return { type: "error", message: detail, status: 500, errorType: "server_error" };
  }
}

/** Map a CLI stopReason to the Responses wire convention. */
export function stopReasonFromCli(reason: string | undefined): "stop" | "tool_use" | "max_tokens" | undefined {
  switch (reason) {
    case "end_turn":
    case "stop":
      return "stop";
    case "tool_use":
    case "tool_calls":
      return "tool_use";
    case "max_turns":
    case "max_tokens":
      return "max_tokens";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface CliAdapterOptions extends CliOptions {
  /** commandcodex/<tail> → the value passed to the CLI's -m flag. */
  resolveCliModel: (modelId: string) => string;
  /** The Provider API key (passed to the CLI as COMMAND_CODE_API_KEY). */
  apiKey: string;
  /** Reasoning-effort flag passthrough when Codex requested one. */
  resolveEffort?: (modelId: string, requested?: string) => string | undefined;
}

/**
 * Resolve the CLI binary. launchd agents run with a minimal PATH, so a bare name is
 * searched against the usual install locations (bun global, homebrew, npm global) in
 * addition to the inherited PATH.
 */
function resolveCliBin(cliPath: string | undefined): string {
  const configured = cliPath?.trim() || CLI_DEFAULT;
  if (configured.includes("/")) return configured;
  const extraDirs = [
    join(homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/opt/node/bin",
    "/usr/local/bin",
    join(homedir(), "bin"),
  ];
  for (const dir of [...extraDirs, ...(process.env.PATH ?? "").split(":")]) {
    if (!dir) continue;
    const candidate = join(dir, configured);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* keep searching */ }
  }
  return configured; // let spawn produce its own ENOENT error message
}

interface PendingTool {
  id: string;
  name: string;
  argsJson: string;
  emittedStart: boolean;
}

export function createCliAdapter(options: CliAdapterOptions): ProviderAdapter {
  const { resolveCliModel, apiKey, resolveEffort } = options;

  return {
    name: "commancodex-cli",
    async runTurn(
      parsed: CodexParsedRequest,
      incoming: IncomingMeta,
      emit: (event: AdapterEvent) => void,
    ): Promise<void> {
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await runTurnOnce(parsed, incoming, emit);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };

  function buildArgs(parsed: CodexParsedRequest): string[] {
    const args = ["-p", "--output-format", "json", "--skip-onboarding"];
    args.push("-m", resolveCliModel(parsed.modelId));
    const effort = resolveEffort?.(parsed.modelId, parsed.options.reasoning);
    if (effort) args.push("--effort", effort);
    return args;
  }

  async function runTurnOnce(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    const prompt = buildCliPrompt(parsed);
    // The CLI is a `#!/usr/bin/env node` script — node must be on the child's PATH.
    const cliBin = resolveCliBin(options.cliPath);
    const childEnvPath = [
      join(homedir(), ".bun", "bin"),
      "/opt/homebrew/opt/node/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      process.env.PATH ?? "/usr/bin:/bin",
    ].join(":");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliBin, buildArgs(parsed), {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: childEnvPath,
          COMMAND_CODE_API_KEY: apiKey,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          // Non-interactive: never trip TTY detection.
          CI: "1",
        },
      });
    } catch (error) {
      emit({
        type: "error",
        message: `failed to launch the command-code CLI (${cliBin}): ${errorText(error)}. Install it with 'bun add -g command-code' or set cliPath in config.json.`,
        status: 502,
        errorType: "server_error",
        code: "cli_spawn_failed",
      });
      return;
    }

    let stderr = "";
    let settled = false;
    let toolSeq = 0;
    let currentTool: PendingTool | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let stopReason: string | undefined;
    let sawToolTag = false;

    const abortHandler = () => {
      if (!settled) child.kill("SIGTERM");
    };
    incoming.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    const finishTool = () => {
      if (!currentTool) return;
      if (!currentTool.emittedStart) {
        emit({ type: "tool_call_start", id: currentTool.id, name: currentTool.name });
        currentTool.emittedStart = true;
      }
      emit({ type: "tool_call_delta", arguments: currentTool.argsJson || "{}" });
      emit({ type: "tool_call_end" });
      currentTool = undefined;
    };

    const handleText = (text: string, emit2: (event: AdapterEvent) => void) => {
      void emit2;
      // Tool tags are extracted from the accumulated text stream, not emitted raw.
      void text;
    };

    const processEvent = (frame: NdjsonEvent) => {
      if (frame.type === "result") {
        usage = frame.usage ? { inputTokens: frame.usage.inputTokens ?? 0, outputTokens: frame.usage.outputTokens ?? 0 } : usage;
        stopReason = frame.stopReason ?? stopReason;
        return;
      }
      const event = frame.event;
      if (!event) return;
      switch (event.type) {
        case "text_delta": {
          const delta = event.delta ?? "";
          if (!delta) break;
          toolBuffer += delta;
          // Hold back any trailing partial tool tag: it must never reach the user.
          let safeLength = toolBuffer.length;
          if (hasOpenToolTag(toolBuffer)) {
            const openIndex = toolBuffer.lastIndexOf(TOOL_OPEN);
            safeLength = openIndex;
          } else {
            // Also hold back a partial opening marker at the very end.
            for (let keep = Math.min(TOOL_OPEN.length - 1, toolBuffer.length); keep > 0; keep--) {
              if (toolBuffer.endsWith(TOOL_OPEN.slice(0, keep))) { safeLength = toolBuffer.length - keep; break; }
            }
          }
          if (safeLength > 0) {
            const visible = toolBuffer.slice(0, safeLength);
            toolBuffer = toolBuffer.slice(safeLength);
            if (visible) emit({ type: "text_delta", text: visible, phase: "final_answer" });
          }
          break;
        }
        case "model_request_end": {
          const mapped = event.usage ? { inputTokens: event.usage.inputTokens ?? 0, outputTokens: event.usage.outputTokens ?? 0 } : undefined;
          if (mapped) usage = mapped;
          if (event.stopReason) stopReason = event.stopReason;
          break;
        }
        default:
          break; // run_start / turn_start / message_* / model_trace / unknown → forward-compatible
      }
    };

    let toolBuffer = "";

    const drainBuffer = (): void => {
      // Extract complete tool tags; emit residual text.
      for (;;) {
        const { tag, rest } = extractToolTag(toolBuffer);
        if (!tag) {
          if (!hasOpenToolTag(toolBuffer) && toolBuffer) {
            emit({ type: "text_delta", text: toolBuffer, phase: "final_answer" });
            toolBuffer = "";
          }
          return;
        }
        // Text before the tag goes out first.
        if (tag.raw) emit({ type: "text_delta", text: tag.raw, phase: "final_answer" });
        sawToolTag = true;
        finishTool(); // close any previous tool before starting a new one
        toolSeq += 1;
        currentTool = {
          id: `ccx_tool_${toolSeq}`,
          name: tag.name,
          argsJson: JSON.stringify(tag.arguments ?? {}),
          emittedStart: false,
        };
        toolBuffer = rest;
      }
    };

    const stdout = child.stdout!;
    const stderrStream = child.stderr!;
    stdout.setEncoding("utf8");
    let lineBuf = "";
    stdout.on("data", (chunk: string) => {
      lineBuf += chunk;
      let newlineIndex: number;
      while ((newlineIndex = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, newlineIndex).trim();
        lineBuf = lineBuf.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as NdjsonEvent;
          processEvent(frame);
          drainBuffer();
        } catch {
          // Non-JSON noise on stdout — ignore (CLI keeps stdout machine-clean per docs).
        }
      }
    });
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    const closed = new Promise<number | null>(resolve => {
      child.on("close", code => resolve(code));
    });

    child.stdin.write(prompt);
    await new Promise<void>(resolve => child.stdin.end(resolve));

    // Stream while the CLI runs; abort kills the child.
    const exitCode = await closed;
    settled = true;
    incoming.abortSignal?.removeEventListener("abort", abortHandler);

    // Flush whatever is left in the tag buffer (a closed-but-unextracted tag, or plain text).
    if (hasOpenToolTag(toolBuffer)) {
      // Unterminated tag at EOF — treat as text minus the opening marker.
      const openIndex = toolBuffer.indexOf(TOOL_OPEN);
      if (openIndex >= 0) {
        const before = toolBuffer.slice(0, openIndex);
        const inner = toolBuffer.slice(openIndex + TOOL_OPEN.length);
        if (before) emit({ type: "text_delta", text: before, phase: "final_answer" });
        if (inner.trim()) {
          try {
            const parsedTag = JSON.parse(inner.trim()) as { name?: unknown; arguments?: unknown };
            if (typeof parsedTag.name === "string") {
              finishTool();
              toolSeq += 1;
              currentTool = { id: `ccx_tool_${toolSeq}`, name: parsedTag.name, argsJson: JSON.stringify(parsedTag.arguments ?? {}), emittedStart: false };
            }
          } catch {
            emit({ type: "text_delta", text: inner, phase: "final_answer" });
          }
        }
      }
      toolBuffer = "";
    }
    drainBuffer();
    finishTool();

    void handleText;
    void sawToolTag;

    if (exitCode !== 0 && exitCode !== null) {
      emit(errorEventForExit(exitCode, stderr));
      return;
    }

    emit({
      type: "done",
      stopReason: stopReasonFromCli(stopReason) ?? (currentTool ? "tool_use" : "stop"),
      endTurn: !currentTool,
      usage,
    });
  }
}
