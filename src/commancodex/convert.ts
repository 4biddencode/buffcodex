/**
 * Codex parsed-Responses ↔ Commancodex Provider API conversions.
 *
 * Two wire shapes:
 * - OpenAI Chat Completions (/provider/v1/chat/completions) — the standard shape;
 *   no CLI-fingerprint fields (codebuff_metadata,
 *   provider block, write_todos shim): none of that is needed — this is a real API key
 *   speaking a real contract, so the request carries only what Codex asked for.
 * - Anthropic Messages (/provider/v1/messages) — Claude models. Their docs pin Claude
 *   to /messages; the parser emits thinking with signatures so Codex can replay them.
 */
import type {
  AdapterEvent,
  CodexContentPart,
  CodexMessage,
  CodexParsedRequest,
  CodexTool,
  CodexToolChoice,
  CodexUsage,
} from "../types";
import { namespacedToolName } from "../types";
import { resolveReasoningEffort } from "../models-catalog";

// ---------------------------------------------------------------------------
// OpenAI Chat Completions shape
// ---------------------------------------------------------------------------

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

/** Freeform (apply_patch-style) and tool_search tools cannot ride the function format. */
function supportsFunctionFormat(tool: CodexTool): boolean {
  return !tool.freeform && !tool.toolSearch;
}

export function buildChatMessages(parsed: CodexParsedRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = (parsed.context.systemPrompt ?? []).join("\n\n").trim();
  if (system) messages.push({ role: "system", content: system });

  for (const message of parsed.context.messages) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: contentPartsToChat(message.content) });
        break;
      case "developer":
        // Their docs only promise the OpenAI schema; developer context rides as system
        // (mirrors the chat converter).
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
  const toolCalls: ChatToolCall[] = [];
  for (const part of content) {
    if (part.type === "text") textParts.push(part.text);
    else if (part.type === "thinking") continue; // chat-completions history carries no thinking
    else {
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
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

export function buildChatTools(parsed: CodexParsedRequest): ChatTool[] | undefined {
  const tools = parsed.context.tools?.filter((tool: CodexTool) => supportsFunctionFormat(tool));
  if (!tools || tools.length === 0) return undefined;
  return tools.map(chatToolFromCodex);
}

export function buildChatCompletionRequest(
  parsed: CodexParsedRequest,
  upstreamModel: string,
): ChatCompletionRequest {
  const options = parsed.options;
  const body: ChatCompletionRequest = {
    model: upstreamModel,
    messages: buildChatMessages(parsed),
    stream: true,
  };
  const tools = buildChatTools(parsed);
  if (tools && tools.length > 0) {
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
  const effort = resolveReasoningEffort(parsed.modelId, options.reasoning);
  if (effort) body.reasoning_effort = effort;
  return body;
}

// ---------------------------------------------------------------------------
// Anthropic Messages shape
// ---------------------------------------------------------------------------

interface AnthropicTextBlock { type: "text"; text: string }
interface AnthropicImageBlock { type: "image"; source: { type: "base64" | "url"; media_type?: string; data?: string; url?: string } }
interface AnthropicThinkingBlock { type: "thinking"; thinking: string; signature?: string }
interface AnthropicRedactedThinkingBlock { type: "redacted_thinking"; data: string }
interface AnthropicToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface AnthropicToolResultBlock { type: "tool_result"; tool_use_id: string; content: string | AnthropicTextBlock[]; is_error?: boolean }

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream: true;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: { type: "enabled"; budget_tokens: number };
}

const DEFAULT_ANTHROPIC_MAX_TOKENS = 32_000;

export function buildAnthropicMessagesRequest(
  parsed: CodexParsedRequest,
  upstreamModel: string,
): AnthropicMessagesRequest {
  const options = parsed.options;
  const system = (parsed.context.systemPrompt ?? []).join("\n\n").trim();
  const messages: AnthropicMessage[] = [];

  for (const message of parsed.context.messages) {
    switch (message.role) {
      case "user":
        messages.push({ role: "user", content: anthropicUserContent(message.content) });
        break;
      case "developer":
        // Anthropic has no developer role; it rides in the system prompt.
        break;
      case "agentMessage":
        messages.push({ role: "user", content: anthropicUserContent(message.content) });
        break;
      case "assistant":
        messages.push(assistantToAnthropic(message.content));
        break;
      case "toolResult":
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: typeof message.content === "string"
              ? message.content
              : anthropicUserContent(message.content) as AnthropicTextBlock[],
            ...(message.isError ? { is_error: true } : {}),
          }],
        });
        break;
    }
  }

  const body: AnthropicMessagesRequest = {
    model: upstreamModel,
    max_tokens: options.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages,
    stream: true,
    ...(system ? { system } : {}),
  };

  // Thinking: enable when Codex asked for reasoning and the request ladder allows it.
  const effort = resolveReasoningEffort(parsed.modelId, options.reasoning);
  if (effort) {
    const budgets: Record<string, number> = { low: 2_048, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_000 };
    const budget = Math.min(budgets[effort] ?? 8_192, body.max_tokens - 1_024);
    if (budget >= 1_024) body.thinking = { type: "enabled", budget_tokens: budget };
  }

  const tools = parsed.context.tools?.filter((tool: CodexTool) => supportsFunctionFormat(tool));
  if (tools && tools.length > 0) {
    body.tools = tools.map(tool => ({
      name: namespacedToolName(tool.namespace, tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: (tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
    const choice = options.toolChoice;
    if (choice === "required") body.tool_choice = { type: "any" };
    else if (typeof choice === "object" && "name" in choice) body.tool_choice = { type: "tool", name: choice.name };
    else if (choice === "none") body.tools = undefined; // Anthropic has no "none"; drop tools entirely
  }

  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.stopSequences?.length) body.stop_sequences = options.stopSequences;
  return body;
}

function anthropicUserContent(content: string | CodexContentPart[]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  const out: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
    else out.push(anthropicImageBlock(part.imageUrl, part.detail));
  }
  if (out.length === 0) return "";
  if (out.every(block => block.type === "text")) {
    return out.map(block => (block as AnthropicTextBlock).text).join("");
  }
  return out;
}

/** data: URLs → base64 blocks; remote https URLs → url-source blocks. */
function anthropicImageBlock(imageUrl: string, detail?: string): AnthropicImageBlock {
  void detail;
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (dataMatch) {
    const mediaType = dataMatch[1] || "image/png";
    if (dataMatch[2]) {
      return { type: "image", source: { type: "base64", media_type: mediaType, data: dataMatch[3]! } };
    }
    return { type: "image", source: { type: "url", url: imageUrl } };
  }
  return { type: "image", source: { type: "url", url: imageUrl } };
}

function assistantToAnthropic(content: Array<
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string; redacted?: string[] }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; namespace?: string }
>): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "thinking") {
      if (part.redacted?.length) {
        for (const data of part.redacted) blocks.push({ type: "redacted_thinking", data });
      } else if (part.thinking && part.signature) {
        // Replay requires the signature — unsigned thinking cannot be re-sent.
        blocks.push({ type: "thinking", thinking: part.thinking, signature: part.signature });
      }
    } else if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else {
      blocks.push({
        type: "tool_use",
        id: part.id,
        name: namespacedToolName(part.namespace, part.name),
        input: part.arguments ?? {},
      });
    }
  }
  // Anthropic requires non-empty assistant content; synthesize a placeholder when the
  // history only carried tool calls we could not replay.
  if (blocks.length === 0) return { role: "assistant", content: [{ type: "text", text: "(tool call)" }] };
  return { role: "assistant", content: blocks };
}

// ---------------------------------------------------------------------------
// Upstream SSE → AdapterEvents
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
): CodexUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = Math.max(0, Math.trunc(usage.prompt_tokens ?? 0));
  const completionTokens = Math.max(0, Math.trunc(usage.completion_tokens ?? 0));
  const cached = Math.max(0, Math.trunc(usage.prompt_tokens_details?.cached_tokens ?? 0));
  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    ...(usage.total_tokens !== undefined
      ? { totalTokens: Math.max(Math.trunc(usage.total_tokens), promptTokens + completionTokens) }
      : {}),
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
  };
}

export function stopReasonFromFinish(finish: string | null | undefined): "stop" | "tool_use" | "max_tokens" | "content_filter" | undefined {
  switch (finish) {
    case "stop":
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
    case "max_tokens":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

export function parseChatSseChunk(raw: string): ChatChunk | null {
  return parseDataSse(raw);
}

function parseDataSse<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

// Anthropic SSE event shapes (subset that carries stream content).
export interface AnthropicSseEvent {
  type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop" | "error" | "ping";
  index?: number;
  error?: { type?: string; message?: string };
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function parseAnthropicSse(raw: string): AnthropicSseEvent | null {
  return parseDataSse(raw);
}

/** Anthropic usage → canonical Codex usage (input INCLUDES cache reads/writes). */
export function usageFromAnthropic(event: AnthropicSseEvent): CodexUsage | undefined {
  const usage = event.message?.usage ?? event.usage;
  if (!usage) return undefined;
  const input = Math.max(0, Math.trunc(usage.input_tokens ?? 0));
  const output = Math.max(0, Math.trunc(usage.output_tokens ?? 0));
  const cacheRead = Math.max(0, Math.trunc(usage.cache_read_input_tokens ?? 0));
  const cacheWrite = Math.max(0, Math.trunc(usage.cache_creation_input_tokens ?? 0));
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead, cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheCreationInputTokens: cacheWrite } : {}),
  };
}
