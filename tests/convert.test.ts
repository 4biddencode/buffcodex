/**
 * Commandcodex converter tests — chat-completions requests, Anthropic messages requests,
 * and SSE → AdapterEvent mapping helpers.
 */
import { describe, expect, test } from "bun:test";
import {
  buildChatCompletionRequest,
  buildAnthropicMessagesRequest,
  collectReasoningTexts,
  parseChatSseChunk,
  parseAnthropicSse,
  stopReasonFromFinish,
  usageFromChunk,
  usageFromAnthropic,
  type ChatChunk,
  type AnthropicSseEvent,
} from "../src/commancodex/convert";
import { isAnthropicModel } from "../src/commancodex/client";
import { modelCapabilities, resolveReasoningEffort } from "../src/models-catalog";
import type { CodexParsedRequest } from "../src/types";

const now = Date.now();

function baseParsed(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "commancodex/deepseek/deepseek-v4-flash",
    context: { messages: [] },
    stream: true,
    options: {},
    ...overrides,
  };
}

describe("isAnthropicModel", () => {
  test("routes Claude to /messages and everything else to chat-completions", () => {
    expect(isAnthropicModel("claude-opus-5")).toBe(true);
    expect(isAnthropicModel("claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicModel("gpt-5.6-sol")).toBe(false);
    expect(isAnthropicModel("deepseek/deepseek-v4-pro")).toBe(false);
    expect(isAnthropicModel("moonshotai/Kimi-K3")).toBe(false);
  });
});

describe("buildChatCompletionRequest", () => {
  test("maps system, user, and tool results; carries options through", () => {
    const parsed = baseParsed({
      context: {
        systemPrompt: ["You are Codex."],
        messages: [
          { role: "user", content: "list the files", timestamp: now },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "shell", arguments: { command: ["ls"] } },
            ],
            timestamp: now,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "a.txt\nb.txt", isError: false, timestamp: now },
        ],
        tools: [
          { name: "shell", description: "run shell", parameters: { type: "object", properties: {} } },
          { name: "apply_patch", description: "patch", parameters: { type: "object", properties: {} }, freeform: true },
        ],
      },
      options: { temperature: 0.2, maxOutputTokens: 512, reasoning: "high" },
    });
    const body = buildChatCompletionRequest(parsed, "deepseek/deepseek-v4-flash");
    expect(body.model).toBe("deepseek/deepseek-v4-flash");
    expect(body.stream).toBe(true);
    const systemMessages = body.messages.filter(message => message.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(JSON.stringify(body.messages)).toContain("call_1");
    // Freeform tools cannot ride the function format — dropped, not crash.
    expect(body.tools?.map(tool => tool.function.name)).toEqual(["shell"]);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
    expect(body.reasoning_effort).toBe("high");
  });

  test("strips reasoning_effort for non-thinking models", () => {
    const parsed = baseParsed({
      modelId: "commancodex/mimo/mimo-v2.5",
      options: { reasoning: "max" },
    });
    const body = buildChatCompletionRequest(parsed, "mimo/mimo-v2.5");
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("no CLI-fingerprint fields leak into the official request", () => {
    const body = buildChatCompletionRequest(baseParsed(), "gpt-5.6-sol");
    expect(JSON.stringify(body)).not.toContain("codebuff_metadata");
    expect(JSON.stringify(body)).not.toContain("write_todos");
    expect(JSON.stringify(body)).not.toContain("data_collection");
  });
});

describe("buildAnthropicMessagesRequest", () => {
  test("builds system + thinking + tools in Anthropic shape", () => {
    const parsed = baseParsed({
      modelId: "commancodex/claude-opus-5",
      context: {
        systemPrompt: ["You are Codex."],
        messages: [
          { role: "user", content: "hi", timestamp: now },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "pondering", signature: "sig123" },
              { type: "text", text: "hello" },
            ],
            timestamp: now,
          },
          { role: "user", content: "use the tool", timestamp: now },
        ],
        tools: [{ name: "shell", description: "run shell", parameters: { type: "object", properties: {} } }],
      },
      options: { reasoning: "high", maxOutputTokens: 16_000 },
    });
    const body = buildAnthropicMessagesRequest(parsed, "claude-opus-5");
    expect(body.model).toBe("claude-opus-5");
    expect(body.system).toBe("You are Codex.");
    expect(body.max_tokens).toBe(16_000);
    expect(body.thinking?.type).toBe("enabled");
    expect(body.thinking!.budget_tokens).toBeLessThan(16_000);
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0]!.name).toBe("shell");
    const assistant = body.messages.find(message => message.role === "assistant");
    expect(Array.isArray(assistant!.content)).toBe(true);
    const blocks = assistant!.content as Array<{ type: string }>;
    expect(blocks.some(block => block.type === "thinking")).toBe(true);
  });

  test("unsigned thinking is not replayed (Anthropic requires signatures)", () => {
    const parsed = baseParsed({
      modelId: "commancodex/claude-opus-5",
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "no signature here" }],
            timestamp: now,
          },
          { role: "user", content: "go on", timestamp: now },
        ],
      },
    });
    const body = buildAnthropicMessagesRequest(parsed, "claude-opus-5");
    const assistant = body.messages.find(message => message.role === "assistant");
    const blocks = assistant!.content as Array<{ type: string }>;
    expect(blocks.some(block => block.type === "thinking")).toBe(false);
  });
});

describe("SSE parsing", () => {
  test("chat chunks parse, [DONE] and comments drop", () => {
    expect(parseChatSseChunk('data: {"choices":[{"delta":{"content":"hi"}}]}') as ChatChunk | null)
      .toEqual({ choices: [{ delta: { content: "hi" } }] });
    expect(parseChatSseChunk("data: [DONE]")).toBeNull();
    expect(parseChatSseChunk(": keepalive")).toBeNull();
    expect(parseChatSseChunk("not sse")).toBeNull();
  });

  test("anthropic events parse", () => {
    const event = parseAnthropicSse('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hey"}}') as AnthropicSseEvent | null;
    expect(event?.type).toBe("content_block_delta");
    expect(event?.delta?.text).toBe("hey");
  });

  test("usage maps from both wire shapes", () => {
    const chatUsage = usageFromChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } });
    expect(chatUsage?.inputTokens).toBe(100);
    expect(chatUsage?.outputTokens).toBe(20);
    expect(chatUsage?.cachedInputTokens).toBe(40);
    const anthropicEvent = {
      type: "message_start",
      message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 25, cache_creation_input_tokens: 5 } },
    } as AnthropicSseEvent;
    const anthropicUsage = usageFromAnthropic(anthropicEvent);
    expect(anthropicUsage?.inputTokens).toBe(50);
    expect(anthropicUsage?.cachedInputTokens).toBe(25);
    expect(anthropicUsage?.cacheCreationInputTokens).toBe(5);
  });

  test("stop reasons normalize", () => {
    expect(stopReasonFromFinish("tool_calls")).toBe("tool_use");
    expect(stopReasonFromFinish("max_tokens")).toBe("max_tokens");
    expect(stopReasonFromFinish("end_turn")).toBe("stop");
    expect(stopReasonFromFinish(undefined)).toBeUndefined();
  });
});

describe("model capabilities", () => {
  test("thinking vs non-thinking detection", () => {
    expect(modelCapabilities("claude-opus-5").reasoning).toBe(true);
    expect(modelCapabilities("gpt-5.3-codex").reasoning).toBe(true);
    expect(modelCapabilities("mimo/mimo-v2.5").reasoning).toBe(false);
    expect(modelCapabilities("upstage/solar-pro4").reasoning).toBe(false);
  });

  test("efforts clamp to the model ladder, ties up", () => {
    expect(resolveReasoningEffort("mimo/mimo-v2.5", "max")).toBeUndefined();
    expect(resolveReasoningEffort("deepseek/deepseek-v4-flash", "medium")).toBe("high");
    expect(resolveReasoningEffort("claude-opus-5", "xhigh")).toBe("high");
  });
});

describe("collectReasoningTexts", () => {
  test("handles strings, arrays, and {text} objects", () => {
    expect(collectReasoningTexts("plain")).toEqual(["plain"]);
    expect(collectReasoningTexts([{ text: "a" }, "b"])).toEqual(["a", "b"]);
    expect(collectReasoningTexts(null)).toEqual([]);
  });
});
