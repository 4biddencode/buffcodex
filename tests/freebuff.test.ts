import { describe, expect, test } from "bun:test";
import { buildModelMapping, parseAllFreeModels, parseFreeAgentsWithSources, resolveModelEntry } from "../src/freebuff/models";
import { generateClientSessionId, parseOptionalTimeMs, queuedPollDelayMs } from "../src/freebuff/upstream";
import { WaitingRoomError } from "../src/freebuff/pool";

describe("parseAllFreeModels", () => {
  test("extracts agent→models sets from free-agents.ts source", () => {
    const source = `
export const FREE_AGENTS = {
  'base2-free': new Set(['minimax/minimax-m2.7', 'z-ai/glm-5.1']),
  'basher': new Set(['google/gemini-3.1-flash-lite-preview']),
  'editor-lite': new Set(['minimax/minimax-m2.7', 'z-ai/glm-5.1']),
}`;
    const parsed = parseAllFreeModels(source);
    expect(parsed["base2-free"]).toEqual(["minimax/minimax-m2.7", "z-ai/glm-5.1"]);
    expect(parsed["basher"]).toEqual(["google/gemini-3.1-flash-lite-preview"]);
    expect(parsed["editor-lite"]).toEqual(["minimax/minimax-m2.7", "z-ai/glm-5.1"]);
  });

  test("skips agents with no models", () => {
    const parsed = parseAllFreeModels(`'empty': new Set([])`);
    expect(parsed).toEqual({});
  });
});

describe("buildModelMapping", () => {
  test("routes only through concrete root agents (free_mode_invalid_agent_hierarchy)", () => {
    const { modelToAgent, allModels } = buildModelMapping({
      "base2-free": ["z-ai/glm-5.1", "openai/gpt-5.6-luna"],
      "base2-free-luna": ["openai/gpt-5.6-luna"],
      "base2-free-evals": ["minimax/minimax-m3"],
      "base2-free-glm-5-3-flash": ["z-ai/glm-5.3-flash"],
      "basher": ["google/gemini-3.1-flash-lite-preview", "z-ai/glm-5.1"],
      "code-reviewer-glm-5-1": ["z-ai/glm-5.1"],
    });
    // Only concrete root templates serve models: bare base2-free has no template upstream,
    // subagents and *-evals variants are not session roots.
    expect(allModels).toEqual(["openai/gpt-5.6-luna", "z-ai/glm-5.3-flash"]);
    expect(modelToAgent["z-ai/glm-5.3-flash"]).toBe("base2-free-glm-5-3-flash");
    expect(modelToAgent["openai/gpt-5.6-luna"]).toBe("base2-free-luna");
  });
});

describe("identifier-constant resolution (current free-agents.ts format)", () => {
  const constants = `
export const FREEBUFF_LUNA_MODEL_ID = 'openai/gpt-5.6-luna'
export const FREEBUFF_GLM_MODEL_ID: FreebuffModelId =
  'z-ai/glm-5.2'
export const mimoModels = {
  mimoV25: 'mimo/mimo-v2.5',
} as const
export const FREEBUFF_MIMO_MODEL_ID = mimoModels.mimoV25
export const FREEBUFF_ALIAS_MODEL_ID = FREEBUFF_LUNA_MODEL_ID
`;
  const agents = `
const OTHER_SET = new Set(['should/not/leak'])
export const FREE_MODE_AGENT_MODELS: Record<string, Set<string>> = {
  'base2-free': new Set([
    FREEBUFF_LUNA_MODEL_ID,
    FREEBUFF_GLM_MODEL_ID,
    FREEBUFF_MIMO_MODEL_ID,
  ]),
  'base2-free-luna': new Set([FREEBUFF_ALIAS_MODEL_ID]),
  'base2-free-quoted': new Set(['quoted/model-id']),
}`;

  test("resolves constants, dotted aliases, chained aliases, and quoted ids", () => {
    const parsed = parseFreeAgentsWithSources(agents, [constants]);
    expect(parsed["base2-free"]).toEqual(["openai/gpt-5.6-luna", "z-ai/glm-5.2", "mimo/mimo-v2.5"]);
    expect(parsed["base2-free-luna"]).toEqual(["openai/gpt-5.6-luna"]);
    expect(parsed["base2-free-quoted"]).toEqual(["quoted/model-id"]);
    expect(JSON.stringify(parsed)).not.toContain("should/not/leak");
  });

  test("resolveModelEntry returns null for unknown tokens", () => {
    expect(resolveModelEntry("'a/b'", {}, {})).toBe("a/b");
    expect(resolveModelEntry("UNKNOWN_X", {}, {})).toBeNull();
    expect(resolveModelEntry("obj.prop", {}, { obj: { prop: "x/y" } })).toBe("x/y");
  });

  test("legacy all-quoted format still parses", () => {
    const parsed = parseAllFreeModels("FREE_MODE_AGENT_MODELS = { 'a-free': new Set(['x/y', 'z/w']) }");
    expect(parsed["a-free"]).toEqual(["x/y", "z/w"]);
  });
});

describe("upstream helpers", () => {
  test("generateClientSessionId matches the SDK shape", () => {
    const id = generateClientSessionId();
    expect(id).toMatch(/^[0-9a-z]{13}$/);
  });

  test("parseOptionalTimeMs handles RFC3339 and empty values", () => {
    expect(parseOptionalTimeMs(undefined)).toBe(0);
    expect(parseOptionalTimeMs("")).toBe(0);
    expect(parseOptionalTimeMs("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(parseOptionalTimeMs("garbage")).toBe(0);
  });

  test("queuedPollDelayMs clamps to [1s, 5s]", () => {
    expect(queuedPollDelayMs({ status: "queued", instanceId: "x", position: 1, queueDepth: 2, estimatedWaitMs: 200 })).toBe(1_000);
    expect(queuedPollDelayMs({ status: "queued", instanceId: "x", position: 1, queueDepth: 2, estimatedWaitMs: 600_000 })).toBe(5_000);
    expect(queuedPollDelayMs({ status: "queued", instanceId: "x", position: 1, queueDepth: 2 })).toBe(5_000);
  });
});

describe("WaitingRoomError", () => {
  test("formats position and retry hint", () => {
    const error = new WaitingRoomError({ accountName: "account-1", position: 3, queueDepth: 7, retryAfterMs: 90_000 });
    expect(error.message).toContain("account-1");
    expect(error.message).toContain("position 3/7");
    expect(error.message).toContain("90s");
  });
});
