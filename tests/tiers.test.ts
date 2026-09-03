import { describe, expect, test } from "bun:test";
import { ModelRegistry, parseModelTiers } from "../src/freebuff/models";
import type { RegistryFetch } from "../src/freebuff/models";

describe("tier parsing", () => {
  const sources = [`
export const FREEBUFF_LUNA_MODEL_ID = 'openai/gpt-5.6-luna'
export const FREEBUFF_SOLAR_MODEL_ID = 'upstage/solar-pro4'
export const FREEBUFF_FABLE_MODEL_ID = 'anthropic/claude-fable-5'
export const FREEBUFF_M3_MODEL_ID = 'minimax/minimax-m3'

export const FREEBUFF_PREMIUM_MODEL_IDS = [
  FREEBUFF_LUNA_MODEL_ID,
  FREEBUFF_SOLAR_MODEL_ID,
] as const

export const FREEBUFF_LIMITED_OFFER_MODEL_IDS = [
  FREEBUFF_FABLE_MODEL_ID,
] as const

export const FREEBUFF_PAUSED_FREE_MODEL_IDS: readonly string[] = [
  FREEBUFF_M3_MODEL_ID,
]`];

  test("extracts premium/limited/paused lists with constant resolution", () => {
    const tiers = parseModelTiers(sources);
    expect([...tiers.premium].sort()).toEqual(["openai/gpt-5.6-luna", "upstage/solar-pro4"]);
    expect([...tiers.limited]).toEqual(["anthropic/claude-fable-5"]);
    expect([...tiers.paused]).toEqual(["minimax/minimax-m3"]);
  });
});

describe("ModelRegistry tiers", () => {
  const staged = {
    agents: {
      "base2-free-luna": ["openai/gpt-5.6-luna"],
      "base2-free-glm": ["z-ai/glm-5.2"],
      "base2-free-paused": ["minimax/minimax-m3"],
    },
    sources: [`
export const FREEBUFF_LUNA_MODEL_ID = 'openai/gpt-5.6-luna'
export const FREEBUFF_M3_MODEL_ID = 'minimax/minimax-m3'
export const FREEBUFF_PREMIUM_MODEL_IDS = [FREEBUFF_LUNA_MODEL_ID] as const
export const FREEBUFF_PAUSED_FREE_MODEL_IDS: readonly string[] = [FREEBUFF_M3_MODEL_ID]`],
  };

  test("paused models are filtered from the catalog; tiers resolve", async () => {
    const registry = new ModelRegistry(async (): Promise<RegistryFetch> => staged);
    await registry.start();
    registry.stop();
    expect(registry.models()).toEqual(["openai/gpt-5.6-luna", "z-ai/glm-5.2"]);
    expect(registry.tierFor("openai/gpt-5.6-luna")).toBe("premium");
    expect(registry.tierFor("z-ai/glm-5.2")).toBe("free");
    expect(registry.tierFor("minimax/minimax-m3")).toBe("paused");
    expect(registry.agentForModel("openai/gpt-5.6-luna")).toBe("base2-free-luna");
  });
});
