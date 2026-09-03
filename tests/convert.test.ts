import { describe, expect, test } from "bun:test";
import {
  buildChatCompletionRequest,
  buildChatMessages,
  parseChatSseChunk,
  stopReasonFromFinish,
  usageFromChunk,
  type ChatChunk,
} from "../src/adapters/freebuff/convert";
import {
  freebuffModelCapabilities,
  resolveReasoningEffort,
} from "../src/models-catalog";
import type { CodexParsedRequest } from "../src/types";

const now = Date.now();

function baseParsed(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "z-ai/glm-5.1",
    context: { messages: [] },
    stream: true,
    options: {},
    ...overrides,
  };
}

describe("buildChatMessages", () => {
  test("lifts systemPrompt into a system message", () => {
    const messages = buildChatMessages(baseParsed({
      context: { systemPrompt: ["You are a coding agent."], messages: [] },
    }));
    // The upstream gate requires the CLI marker at messages[0]; Codex's prompt follows.
    expect(messages).toEqual([
      { role: "system", content: "You are Buffy, the coding agent behind Codebuff." },
      { role: "system", content: "You are a coding agent." },
    ]);
  });

  test("maps user, assistant tool calls, and tool results", () => {
    const messages = buildChatMessages(baseParsed({
      context: {
        messages: [
          { role: "user", content: "list files", timestamp: now },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should call the tool" },
              { type: "toolCall", id: "call_1", name: "shell", arguments: { command: ["ls"] } },
            ],
            timestamp: now,
          },
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "shell",
            content: "a.txt\nb.txt",
            isError: false,
            timestamp: now,
          },
        ],
      },
    }));
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "system", content: "You are Buffy, the coding agent behind Codebuff." });
    expect(messages[1]).toEqual({ role: "user", content: "list files" });
    const assistant = messages[2] as { role: string; tool_calls?: Array<{ id: string; function: { name: string } }>; reasoning_content?: string };
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_content).toBe("I should call the tool");
    expect(assistant.tool_calls?.[0]?.id).toBe("call_1");
    expect(assistant.tool_calls?.[0]?.function.name).toBe("shell");
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" });
  });

  test("namespaced tools flatten to namespace__name on round-trip fields", () => {
    const messages = buildChatMessages(baseParsed({
      context: {
        messages: [
          { role: "user", content: "hi", timestamp: now },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "search", arguments: {}, namespace: "mcp__docs" }],
            timestamp: now,
          },
        ],
      },
    }));
    const assistant = messages[2] as { tool_calls?: Array<{ function: { name: string } }> };
    expect(assistant.tool_calls?.[0]?.function.name).toBe("mcp__docs__search");
  });
});

describe("buildChatCompletionRequest", () => {
  test("includes codebuff_metadata with run id and free cost mode", () => {
    const body = buildChatCompletionRequest(baseParsed(), { runId: "run_123" });
    expect(body.model).toBe("z-ai/glm-5.1");
    expect(body.stream).toBe(true);
    expect(body.codebuff_metadata.run_id).toBe("run_123");
    expect(body.codebuff_metadata.cost_mode).toBe("free");
    expect(typeof body.codebuff_metadata.client_id).toBe("string");
  });

  test("propagates session instance id into metadata", () => {
    const body = buildChatCompletionRequest(baseParsed(), { runId: "r", sessionInstanceId: "inst_9" });
    expect(body.codebuff_metadata.freebuff_instance_id).toBe("inst_9");
  });

  test("maps options: reasoning effort, temperature, stop, max tokens", () => {
    const body = buildChatCompletionRequest(baseParsed({
      options: { reasoning: "high", temperature: 0.4, maxOutputTokens: 900, stopSequences: ["END"] },
    }), { runId: "r" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(900);
    expect(body.stop).toBe("END");
  });

  test("omits reasoning_effort for none", () => {
    const body = buildChatCompletionRequest(baseParsed({ options: { reasoning: "none" } }), { runId: "r" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("strips reasoning_effort entirely for non-thinking models", () => {
    for (const modelId of ["mimo/mimo-v2.5", "upstage/solar-pro4"]) {
      const body = buildChatCompletionRequest(
        baseParsed({ modelId, options: { reasoning: "max" } }),
        { runId: "r" },
     );
      expect(body.reasoning_effort).toBeUndefined();
    }
  });

  test("sends glm-5.3-flash effort verbatim within its low/high/max ladder", () => {
    const body = buildChatCompletionRequest(
      baseParsed({ modelId: "z-ai/glm-5.3-flash", options: { reasoning: "max" } }),
      { runId: "r" },
    );
    expect(body.reasoning_effort).toBe("max");
  });

  test("clamps out-of-ladder effort to the nearest supported value (ties up)", () => {
    // glm-5.3-flash has no medium; medium should clamp up to high.
    const body = buildChatCompletionRequest(
      baseParsed({ modelId: "z-ai/glm-5.3-flash", options: { reasoning: "medium" } }),
      { runId: "r" },
    );
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("per-model thinking ladders", () => {
  test("verified ladders match the web UI", () => {
    expect(freebuffModelCapabilities("z-ai/glm-5.3-flash").efforts).toEqual(["low", "high", "max"]);
    expect(freebuffModelCapabilities("deepseek/deepseek-v4-flash").efforts).toEqual(["low", "high", "max"]);
    expect(freebuffModelCapabilities("openai/gpt-5.6-luna").efforts)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(freebuffModelCapabilities("openai/gpt-5.6-luna-max").efforts)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(freebuffModelCapabilities("deepseek/deepseek-v4-pro-max").reasoning).toBe(true);
  });

  test("verified non-thinking models report no reasoning", () => {
    for (const modelId of ["mimo/mimo-v2.5", "upstage/solar-pro4"]) {
      const caps = freebuffModelCapabilities(modelId);
      expect(caps.reasoning).toBe(false);
      expect(caps.efforts).toEqual([]);
    }
  });

  test("glm-5.2 falls back to the family ladder; unknown models do not think", () => {
    expect(freebuffModelCapabilities("z-ai/glm-5.2")).toEqual({ reasoning: true, efforts: ["low", "medium", "high"] });
    expect(freebuffModelCapabilities("crof/kimi-k3-eco")).toEqual({ reasoning: true, efforts: ["low", "medium", "high"] });
    expect(freebuffModelCapabilities("somevendor/unknown-model").reasoning).toBe(false);
  });

  test("resolveReasoningEffort edge cases", () => {
    expect(resolveReasoningEffort("mimo/mimo-v2.5", "max")).toBeUndefined();
    expect(resolveReasoningEffort("upstage/solar-pro4", "high")).toBeUndefined();
    expect(resolveReasoningEffort("z-ai/glm-5.3-flash", "xhigh")).toBe("max");
    expect(resolveReasoningEffort("z-ai/glm-5.3-flash", "minimal")).toBeUndefined();
    expect(resolveReasoningEffort("deepseek/deepseek-v4-flash", "medium")).toBe("high");
    expect(resolveReasoningEffort("deepseek/deepseek-v4-flash", "ultra")).toBe("max");
    expect(resolveReasoningEffort("openai/gpt-5.6-luna", "xhigh")).toBe("xhigh");
    expect(resolveReasoningEffort("z-ai/glm-5.2", "xhigh")).toBe("high");
  });
});

describe("parseChatSseChunk", () => {
  test("parses data frames and ignores comments/done/keepalives", () => {
    expect(parseChatSseChunk('data: {"choices":[]}')).toEqual({ choices: [] });
    expect(parseChatSseChunk("data: [DONE]")).toBeNull();
    expect(parseChatSseChunk(": keepalive")).toBeNull();
    expect(parseChatSseChunk("")).toBeNull();
    expect(parseChatSseChunk("data: not-json")).toBeNull();
  });
});

describe("usageFromChunk", () => {
  test("maps prompt/completion/cached tokens", () => {
    const mapped = usageFromChunk({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 60 },
    });
    expect(mapped?.usage.inputTokens).toBe(100);
    expect(mapped?.usage.outputTokens).toBe(40);
    expect(mapped?.usage.totalTokens).toBe(140);
    expect(mapped?.usage.cachedInputTokens).toBe(60);
  });

  test("returns undefined for missing usage", () => {
    expect(usageFromChunk(undefined)).toBeUndefined();
  });
});

describe("stopReasonFromFinish", () => {
  test("maps finish reasons to adapter stop reasons", () => {
    expect(stopReasonFromFinish("stop")).toBe("stop");
    expect(stopReasonFromFinish("tool_calls")).toBe("tool_use");
    expect(stopReasonFromFinish("function_call")).toBe("tool_use");
    expect(stopReasonFromFinish("length")).toBe("max_tokens");
    expect(stopReasonFromFinish("content_filter")).toBe("content_filter");
    expect(stopReasonFromFinish(null)).toBeUndefined();
  });
});
