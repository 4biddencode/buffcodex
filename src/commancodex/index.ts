/**
 * Commancodex ProviderAdapter — routes a Codex Responses turn through the OFFICIAL
 * Commancodex Provider API with a real API key. No fingerprinting, no session pool,
 * no ban risk: the endpoint is designed for exactly this usage.
 *
 * Wire shapes (per https://commancodex.ai/docs/provider):
 * - Claude models → POST /provider/v1/messages (Anthropic Messages)
 * - everything else → POST /provider/v1/chat/completions (OpenAI)
 */
import type { IncomingMeta, ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, CodexParsedRequest, CodexUsage } from "../types";
import { adapterFailureFromMessage } from "../lib/errors";
import { CommancodexClient, CommancodexError, isAnthropicModel } from "./client";
import {
  buildAnthropicMessagesRequest,
  buildChatCompletionRequest,
  collectReasoningTexts,
  parseAnthropicSse,
  parseChatSseChunk,
  stopReasonFromFinish,
  usageFromAnthropic,
  usageFromChunk,
  type AnthropicSseEvent,
  type ChatChunk,
} from "./convert";
import { errorText } from "../lib/errors";

export interface CommancodexAdapterOptions {
  client: CommancodexClient;
  /** commancodex/<tail> → the upstream model id sent to the API. */
  resolveUpstreamModel: (modelId: string) => string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

interface OpenToolCall {
  id: string;
  name: string;
  args: string;
}

interface AnthropicToolCall {
  id: string;
  name: string;
  inputJson: string;
}

export function createCommancodexAdapter(options: CommancodexAdapterOptions): ProviderAdapter {
  const { client, resolveUpstreamModel } = options;

  return {
    name: "commancodex",
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

  async function runTurnOnce(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    const upstreamModel = resolveUpstreamModel(parsed.modelId);
    const anthropicShape = isAnthropicModel(upstreamModel);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body: Record<string, unknown> = anthropicShape
          ? buildAnthropicMessagesRequest(parsed, upstreamModel) as unknown as Record<string, unknown>
          : buildChatCompletionRequest(parsed, upstreamModel) as unknown as Record<string, unknown>;
        const response = anthropicShape
          ? await client.anthropicMessages(body, incoming.abortSignal)
          : await client.chatCompletion(body, incoming.abortSignal);
        if (anthropicShape) await streamAnthropicResponse(response, emit);
        else await streamChatResponse(response, emit);
        return;
      } catch (error) {
        if (incoming.abortSignal?.aborted) {
          emit({ type: "incomplete", reason: "client_cancelled" });
          return;
        }
        const message = errorText(error);
        const status = error instanceof CommancodexError ? error.status : undefined;
        // One retry rides out a transient 429/5xx.
        if (attempt === 0 && (status === undefined || RETRYABLE_STATUS.has(status))) {
          await new Promise(resolve => setTimeout(resolve, status === 429 ? 3_000 : 1_000));
          continue;
        }
        emitError(emit, message, status, error instanceof CommancodexError ? error.code : undefined);
        return;
      }
    }
  }

  function emitError(emit: (event: AdapterEvent) => void, message: string, status?: number, code?: string): void {
    const { httpStatus, error } = adapterFailureFromMessage(message);
    emit({
      type: "error",
      message: error.message,
      status: status ?? httpStatus,
      errorType: error.type,
      code: code ?? error.code ?? undefined,
    });
  }

  // ── OpenAI chat-completions SSE pump ─────────────────────────────────────
  async function streamChatResponse(response: Response, emit: (event: AdapterEvent) => void): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const openToolCalls = new Map<number, OpenToolCall>();
    let usage: CodexUsage | undefined;
    let stopReason: string | undefined;

    const processChunk = (chunk: ChatChunk) => {
      if (chunk.error) {
        const message = typeof chunk.error === "object" && chunk.error !== null && "message" in chunk.error
          ? String((chunk.error as { message?: unknown }).message)
          : JSON.stringify(chunk.error);
        throw new CommancodexError(message, 502);
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        const mapped = usageFromChunk(chunk.usage ?? undefined);
        if (mapped) usage = mapped;
        return;
      }
      const delta = choice.delta ?? {};

      const reasoningTexts = [
        ...collectReasoningTexts(delta.reasoning_content),
        ...collectReasoningTexts(delta.reasoning),
      ];
      for (const text of reasoningTexts) emit({ type: "thinking_delta", thinking: text });

      if (typeof delta.content === "string" && delta.content.length > 0) {
        emit({ type: "text_delta", text: delta.content, phase: "final_answer" });
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        let open = openToolCalls.get(index);
        const arrivingName = toolCall.function?.name;
        if (!open) {
          // Defer the start until the tool name arrives: the Responses wire requires a
          // named tool_call_start, and backends can split id/name/args across chunks.
          if (!arrivingName) continue;
          open = { id: toolCall.id ?? `call_${index}_${Date.now()}`, name: arrivingName, args: "" };
          openToolCalls.set(index, open);
          emit({ type: "tool_call_start", id: open.id, name: open.name });
        }
        if (toolCall.id && open.id !== toolCall.id) open.id = toolCall.id;
        if (arrivingName && open.name !== arrivingName) open.name = arrivingName;
        if (toolCall.function?.arguments) {
          open.args += toolCall.function.arguments;
          emit({ type: "tool_call_delta", arguments: toolCall.function.arguments });
        }
      }

      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        const mapped = usageFromChunk(chunk.usage ?? undefined);
        if (mapped) usage = mapped;
      } else if (chunk.usage) {
        const mapped = usageFromChunk(chunk.usage);
        if (mapped) usage = mapped;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const chunk = parseChatSseChunk(line);
          if (chunk) processChunk(chunk);
        }
      }
      const tail = parseChatSseChunk(buffer);
      if (tail) processChunk(tail);
    } finally {
      reader.releaseLock();
    }

    for (const open of openToolCalls.values()) emit({ type: "tool_call_end" });

    emit({
      type: "done",
      stopReason: stopReasonFromFinish(stopReason) ?? "stop",
      endTurn: openToolCalls.size === 0,
      usage,
    });
  }

  // ── Anthropic messages SSE pump ──────────────────────────────────────────
  async function streamAnthropicResponse(response: Response, emit: (event: AdapterEvent) => void): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let currentTool: AnthropicToolCall | undefined;
    let usage: CodexUsage | undefined;
    let stopReason: string | undefined;

    const processEvent = (event: AnthropicSseEvent) => {
      switch (event.type) {
        case "error": {
          const message = event.error?.message ?? "anthropic stream error";
          throw new CommancodexError(message, 502);
        }
        case "message_start": {
          const mapped = usageFromAnthropic(event);
          if (mapped) usage = mapped;
          break;
        }
        case "content_block_start": {
          const block: AnthropicSseEvent["content_block"] = event.content_block ?? { type: "" };
          if (block.type === "tool_use") {
            currentTool = {
              id: block.id ?? `toolu_${Date.now()}`,
              name: block.name ?? "",
              inputJson: "",
            };
          } else if (block.type === "redacted_thinking" && block.data) {
            emit({ type: "redacted_thinking", data: block.data });
          }
          break;
        }
        case "content_block_delta": {
          const delta: NonNullable<AnthropicSseEvent["delta"]> = event.delta ?? {};
          if (delta.type === "text_delta" && delta.text) {
            emit({ type: "text_delta", text: delta.text, phase: "final_answer" });
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            emit({ type: "thinking_delta", thinking: delta.thinking });
          } else if (delta.type === "signature_delta" && delta.signature) {
            emit({ type: "thinking_signature", signature: delta.signature });
          } else if (delta.type === "input_json_delta" && delta.partial_json && currentTool) {
            currentTool.inputJson += delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          if (currentTool) {
            emit({ type: "tool_call_start", id: currentTool.id, name: currentTool.name });
            emit({ type: "tool_call_delta", arguments: currentTool.inputJson || "{}" });
            emit({ type: "tool_call_end" });
            currentTool = undefined;
          }
          break;
        }
        case "message_delta": {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          const mapped = usageFromAnthropic(event);
          if (mapped && usage) {
            // message_delta usage carries the FINAL cumulative output count; input
            // arrived with message_start. Keep the larger of each side.
            const output = Math.max(usage.outputTokens, mapped.outputTokens);
            usage = { ...usage, outputTokens: output, totalTokens: usage.inputTokens + output };
          } else if (mapped) usage = mapped;
          break;
        }
        case "message_stop":
        case "ping":
          break;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const event = parseAnthropicSse(line);
          if (event) processEvent(event);
        }
      }
      const tail = parseAnthropicSse(buffer);
      if (tail) processEvent(tail);
    } finally {
      reader.releaseLock();
    }

    if (currentTool) {
      emit({ type: "tool_call_start", id: currentTool.id, name: currentTool.name });
      emit({ type: "tool_call_delta", arguments: currentTool.inputJson || "{}" });
      emit({ type: "tool_call_end" });
    }

    emit({
      type: "done",
      stopReason: stopReasonFromFinish(stopReason) ?? "stop",
      endTurn: !currentTool,
      usage,
    });
  }
}
