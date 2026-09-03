/**
 * Conversions between Codex's parsed Responses world and the Freebuff backend's
 * OpenAI chat-completions surface (ported semantics from Freebuff2API's anthropic.go
 * stream handling, rebuilt for AdapterEvents instead of Claude SSE).
 */
import type {
  AdapterEvent,
  CodexContentPart,
  CodexMessage,
  CodexParsedRequest,
  CodexTool,
  CodexToolChoice,
  CodexUsage,
} from "../../types";
import { namespacedToolName } from "../../types";
import { resolveReasoningEffort } from "../../models-catalog";
import { generateClientSessionId } from "../../freebuff/upstream";

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage =
  | { role: "system" | "user" | "developer"; content: string | ChatContentPart[] }
  | {
      role: "assistant";
      content: string | ChatContentPart[] | null;
      tool_calls?: ChatToolCall[];
      reasoning_content?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string | ChatContentPart[] };

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  reasoning_effort?: string;
  codebuff_metadata: Record<string, unknown>;
  /** CLI fingerprint: top-level provider block — data_collection deny comes from the agent template. */
  provider?: { order?: string[]; allow_fallbacks?: boolean; data_collection?: string };
}

/**
 * The Freebuff backend's server-side client gate (the 403 free_mode_cli_required) requires
 * root-agent chat requests to carry the canonical CLI system prompt at messages[0]
 * (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS in the CLI source's free-agents.ts), and
 * foreign-client-signals.ts downgrades requests whose toolset has no codebuff-only
 * "signature" tool. Codex's toolset (shell/apply_patch/…) is entirely on the GENERIC
 * exclusion list, so without help every turn would be downgraded to a tiny free model.
 *
 * We therefore:
 *  - prepend the base3 CLI root opening as messages[0] (Codex's own instructions follow
 *    as a second system message), and
 *  - always offer write_todos (a signature tool), bridged to Codex's update_plan.
 */
export const FREEBUFF_SYSTEM_MARKER = "You are Buffy, the coding agent behind Codebuff.";

const WRITE_TODOS_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "write_todos",
    description:
      "Use this tool to track your objectives through an ordered step-by-step plan. Call this tool after you have gathered context on the user's request to plan out the implementation steps for the user's request.\n\nAfter completing each todo step, call this tool again to update the list and mark that task as completed. Note that each time you call this tool, rewrite ALL todos with their current status.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "List of todos with their completion status. Add ALL of the applicable tasks to the list, so you don't forget to do anything. Try to order the todos the same way you will complete them. Do not mark todos as completed if you have not completed them yet!",
          items: {
            type: "object",
            properties: {
              task: { type: "string", description: "Description of the task" },
              completed: { type: "boolean", description: "Whether the task is completed" },
            },
            required: ["task", "completed"],
          },
        },
      },
      required: ["todos"],
    },
  },
};

/** Offer write_todos unless the caller already did (it satisfies the signature-tool check). */
function ensureWriteTodos(tools: ChatTool[] | undefined): ChatTool[] {
  if (tools?.some(tool => tool.function.name === "write_todos")) return tools;
  return [...(tools ?? []), WRITE_TODOS_TOOL];
}

/**
 * write_todos arguments → Codex update_plan arguments: {todos:[{task,completed}]} becomes
 * {plan:[{step,status}]} with the first unfinished step marked in_progress.
 */
export function transformTodosArgsToUpdatePlan(args: string): string {
  try {
    const parsed = JSON.parse(args) as { todos?: unknown };
    if (Array.isArray(parsed.todos)) {
      let firstOpenMarked = false;
      const plan = parsed.todos.map(entry => {
        const todo = (typeof entry === "object" && entry !== null ? entry : {}) as {
          task?: unknown;
          completed?: unknown;
        };
        const step = typeof todo.task === "string" ? todo.task : "";
        if (todo.completed === true) return { step, status: "completed" };
        if (firstOpenMarked) return { step, status: "pending" };
        firstOpenMarked = true;
        return { step, status: "in_progress" };
      });
      return JSON.stringify({ plan });
    }
  } catch {
    // Fall through: hand the raw args to Codex rather than dropping the call.
  }
  return args;
}

function contentPartsToChat(parts: string | CodexContentPart[]): string | ChatContentPart[] {
  if (typeof parts === "string") return parts;
  const out: ChatContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
    else out.push({ type: "image_url", image_url: { url: part.imageUrl } });
  }
  return out.length === 1 && out[0]!.type === "text" ? out[0]!.text : out;
}

function toolArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

function chatToolFromCodex(tool: CodexTool): ChatTool {
  return {
    type: "function",
    function: {
      name: namespacedToolName(tool.namespace, tool.name),
      description: tool.description ?? "",
      parameters: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  };
}

function mapToolChoice(choice: CodexToolChoice | undefined): ChatCompletionRequest["tool_choice"] {
  if (!choice) return undefined;
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (typeof choice === "object" && "name" in choice) {
    return { type: "function", function: { name: choice.name } };
  }
  if (typeof choice === "object" && "allowedTools" in choice) {
    return choice.mode === "required" ? "required" : "auto";
  }
  return undefined;
}

export function buildChatMessages(parsed: CodexParsedRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Server gate: messages[0] must open with the canonical CLI marker. Codex's real
  // instructions ride right behind it as their own system message.
  messages.push({ role: "system", content: FREEBUFF_SYSTEM_MARKER });
  const system = (parsed.context.systemPrompt ?? []).join("\n\n").trim();
  if (system) messages.push({ role: "system", content: system });

  for (const message of parsed.context.messages) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: contentPartsToChat(message.content) });
        break;
      case "developer":
        // Chat-completions has no developer role on most OpenAI-compatible backends; the
        // Freebuff backend speaks ai-sdk, so developer context rides as system.
        messages.push({ role: "system", content: contentPartsToChat(message.content) });
        break;
      case "agentMessage":
        messages.push({
          role: "user",
          content: typeof message.content === "string"
            ? message.content
            : contentPartsToChat(message.content),
        });
        break;
      case "assistant":
        messages.push(assistantToChat(message.content));
        break;
      case "toolResult":
        messages.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: contentPartsToChat(message.content),
        });
        break;
    }
  }
  return messages;
}

function assistantToChat(content: Array<
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string; redacted?: string[] }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; namespace?: string }
>): ChatMessage {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const part of content) {
    if (part.type === "text") textParts.push(part.text);
    else if (part.type === "thinking") {
      if (part.thinking) reasoningParts.push(part.thinking);
    } else {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: namespacedToolName(part.namespace, part.name),
          arguments: toolArguments(part.arguments),
        },
      });
    }
  }
  const text = textParts.join("");
  return {
    role: "assistant",
    content: text,
    ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join("\n\n") } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function buildChatTools(parsed: CodexParsedRequest): ChatTool[] | undefined {
  const tools = parsed.context.tools;
  if (!tools || tools.length === 0) return undefined;
  return tools.map(chatToolFromCodex);
}

export function buildChatCompletionRequest(
  parsed: CodexParsedRequest,
  metadata: { runId: string; sessionInstanceId?: string },
): ChatCompletionRequest {
  const options = parsed.options;
  // CLI capture: metadata values are STRINGIFIED and ordered:
  // freebuff_instance_id, trace_session_id, run_id, client_id, cost_mode.
  // (repo_snapshot is absent because we have no repo context; llm_step_number omitted.)
  const codebuffMetadata: Record<string, string> = {
    ...(metadata.sessionInstanceId ? { freebuff_instance_id: metadata.sessionInstanceId } : {}),
    trace_session_id: crypto.randomUUID(),
    run_id: metadata.runId,
    client_id: generateClientSessionId(),
    cost_mode: "free",
    // The CLI always sends the step counter (run-agent-step.ts extraCodebuffMetadata).
    llm_step_number: "1",
  };
  const body: ChatCompletionRequest = {
    model: parsed.modelId,
    messages: buildChatMessages(parsed),
    stream: true,
    codebuff_metadata: codebuffMetadata,
    // CLI capture: the freebuff agent templates set data_collection: "deny".
    provider: { data_collection: "deny" },
  };
  const tools = ensureWriteTodos(buildChatTools(parsed));
  if (tools.length > 0) {
    body.tools = tools;
    const choice = mapToolChoice(options.toolChoice);
    if (choice) body.tool_choice = choice;
    if (options.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls;
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.maxOutputTokens !== undefined) body.max_tokens = options.maxOutputTokens;
  if (options.stopSequences !== undefined && options.stopSequences.length > 0) {
    body.stop = options.stopSequences.length === 1 ? options.stopSequences[0]! : options.stopSequences;
  }
  // Per-model thinking support: strip the field entirely for non-thinking models, clamp
  // out-of-ladder efforts to the nearest supported one (ties clamp up — effort is free).
  const effort = resolveReasoningEffort(parsed.modelId, options.reasoning);
  if (effort) body.reasoning_effort = effort;
  return body;
}

// ---------------------------------------------------------------------------
// Upstream chat SSE → AdapterEvents
// ---------------------------------------------------------------------------

export interface ChatChunkChoice {
  index?: number;
  delta?: {
    role?: string;
    content?: string | null;
    reasoning_content?: unknown;
    reasoning?: unknown;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

export interface ChatChunk {
  id?: string;
  model?: string;
  choices?: ChatChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: unknown;
}

export interface UpstreamUsageExtras {
  cachedInputTokens?: number;
}

/** Extract reasoning text(s) from the heterogeneous reasoning_content shapes backends emit. */
export function collectReasoningTexts(value: unknown): string[] {
  const out: string[] = [];
  const walk = (entry: unknown): void => {
    if (typeof entry === "string") {
      if (entry.trim()) out.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item);
      return;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const text = record.text ?? record.thinking;
      if (typeof text === "string" && text.trim()) out.push(text);
    }
  };
  walk(value);
  return out;
}

export function usageFromChunk(
  usage: NonNullable<ChatChunk["usage"]> | undefined,
): { usage: CodexUsage; extras: UpstreamUsageExtras } | undefined {
  if (!usage) return undefined;
  const promptTokens = Math.max(0, Math.trunc(usage.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.trunc(usage.completion_tokens ?? 0));
  const cached = Math.max(0, Math.trunc(usage.prompt_tokens_details?.cached_tokens ?? 0));
  return {
    usage: {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      ...(usage.total_tokens !== undefined
        ? { totalTokens: Math.max(Math.trunc(usage.total_tokens), promptTokens + completionTokens) }
        : {}),
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    },
    extras: cached > 0 ? { cachedInputTokens: cached } : {},
  };
}

export function stopReasonFromFinish(finish: string | null | undefined): "stop" | "tool_use" | "max_tokens" | "content_filter" | undefined {
  switch (finish) {
    case "stop":
    case "end_turn":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

/** Line-by-line parser for the upstream `data:` SSE stream. */
export function parseChatSseChunk(raw: string): ChatChunk | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as ChatChunk;
  } catch {
    return null;
  }
}
