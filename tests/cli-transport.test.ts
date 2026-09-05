/**
 * CLI-transport unit tests: prompt flattening, tool-tag extraction/buffering, exit-code
 * mapping. The real child-process path is exercised live on the target machine.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCliPrompt,
  extractToolTag,
  hasOpenToolTag,
  errorEventForExit,
  stopReasonFromCli,
  TOOL_PROTOCOL_INSTRUCTIONS,
} from "../src/cli-transport/adapter";
import type { CodexParsedRequest } from "../src/types";

const now = Date.now();

function parsed(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "commancodex/MiniMaxAI/MiniMax-M3",
    context: { messages: [] },
    stream: true,
    options: {},
    ...overrides,
  };
}

describe("buildCliPrompt", () => {
  test("embeds system, tools + protocol, and conversation", () => {
    const prompt = buildCliPrompt(parsed({
      context: {
        systemPrompt: ["You are Codex."],
        messages: [
          { role: "user", content: "list files", timestamp: now },
          { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "shell", arguments: { cmd: "ls" } }], timestamp: now },
          { role: "toolResult", toolCallId: "c1", toolName: "shell", content: "a.txt", isError: false, timestamp: now },
        ],
        tools: [{ name: "shell", description: "run shell", parameters: { type: "object", properties: {} } }],
      },
    }));
    expect(prompt).toContain("<system>");
    expect(prompt).toContain("## shell");
    expect(prompt).toContain(TOOL_PROTOCOL_INSTRUCTIONS);
    expect(prompt).toContain("<user>");
    expect(prompt).toContain("<assistant_tool_call>");
    expect(prompt).toContain("<tool_result");
  });

  test("no tools → no protocol section", () => {
    const prompt = buildCliPrompt(parsed({ context: { messages: [{ role: "user", content: "hi", timestamp: now }] } }));
    expect(prompt).not.toContain("ccx-tool");
    expect(prompt).toContain("hi");
  });
});

describe("extractToolTag", () => {
  test("extracts a complete tag and leaves residual text", () => {
    const { tag, rest } = extractToolTag('before<ccx-tool>{"name":"shell","arguments":{"cmd":"ls"}}</ccx-tool>after');
    expect(tag?.name).toBe("shell");
    expect(tag?.arguments).toEqual({ cmd: "ls" });
    expect(tag?.raw).toBe("before");
    expect(rest).toBe("after");
  });

  test("incomplete tag is not extracted (wait for more deltas)", () => {
    const { tag } = extractToolTag("text <ccx-tool>{\"name\":\"sh");
    expect(tag).toBeNull();
    expect(hasOpenToolTag("text <ccx-tool>{\"name\":\"sh")).toBe(true);
    expect(hasOpenToolTag("no tags here")).toBe(false);
  });

  test("malformed tag JSON degrades to plain text", () => {
    const { tag, rest } = extractToolTag("<ccx-tool>not json</ccx-tool>");
    expect(tag).toBeNull();
    expect(rest).toBe("not json");
  });
});

describe("exit codes", () => {
  test("auth failure → 401", () => {
    const event = errorEventForExit(3, 'Error: Not authenticated. Please run "cmd login" first.');
    expect(event.type).toBe("error");
    expect(event.type === "error" && event.status).toBe(401);
  });
  test("rate limit is retryable", () => {
    const event = errorEventForExit(5, "rate limited");
    expect(event.type === "error" && event.status).toBe(429);
    expect(event.type === "error" && event.retryable).toBe(true);
  });
  test("max turns → incomplete", () => {
    expect(errorEventForExit(8, "max turns").type).toBe("incomplete");
  });
});

describe("stop reasons", () => {
  test("maps end_turn and tool_use", () => {
    expect(stopReasonFromCli("end_turn")).toBe("stop");
    expect(stopReasonFromCli("tool_use")).toBe("tool_use");
    expect(stopReasonFromCli(undefined)).toBeUndefined();
  });
});
