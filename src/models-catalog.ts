/**
 * Codex model catalog — builds native-looking model rows for every free Freebuff model so
 * Codex's picker lists them with sane context windows, thinking flags, and per-model
 * reasoning-effort ladders (which also drive Codex's /model effort menu).
 *
 * Evidence base (Freebuff web UI effort menus, user-captured 2026-09):
 * - openai/gpt-5.6-luna: Default/Low/Medium/High/Extra high/Max (full ladder)
 * - deepseek/deepseek-v4-flash: Default/Low/High/Max (no Medium, no Extra high)
 * - z-ai/glm-5.3-flash: Default/Low/High/Max
 * - mimo/mimo-v2.5, upstage/solar-pro4: no thinking control at all
 * The `reasoningEffort` wire value is sent verbatim ("max" included) and carries no extra
 * quota on the web path. The web UI's "Default" entry ≈ omitting the field; Codex always
 * sends an effort, so our catalogs default to the model's maximum instead.
 */

const DEFAULT_CONTEXT_WINDOW = 190_000;
const AUTO_COMPACT_TOKEN_LIMIT = 170_000;

/** Efforts Codex accepts on the wire (parser also allows none/minimal for direct callers). */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface FreebuffModelCapabilities {
  /** Whether the model thinks at all (streams reasoning and accepts reasoning_effort). */
  reasoning: boolean;
  /** Supported efforts, cheapest first; empty when the model does not think. */
  efforts: ReasoningEffort[];
}

const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: "Light deliberation. Fast, inexpensive replies.",
  medium: "Balanced deliberation.",
  high: "More deliberation. Slower replies.",
  xhigh: "Very deep deliberation. Much slower replies.",
  max: "Maximum deliberation this model allows.",
};

const FULL_LADDER: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const FLASH_LADDER: ReasoningEffort[] = ["low", "high", "max"];
const STANDARD_LADDER: ReasoningEffort[] = ["low", "medium", "high"];

/**
 * Verified thinking ladders, keyed by model-id substring. Order matters: first match wins.
 * The deepseek ladder is verified on -flash; -flash-max/-pro/-pro-max reuse it until
 * corrected with fresh menu captures. Luna's menu was captured with "Default" checked,
 * meaning it thinks by default — it gets the full ladder.
 */
const THINKING_LADDERS: Array<{ match: RegExp; efforts: ReasoningEffort[] }> = [
  { match: /openai\/gpt-5\.6-luna/i, efforts: FULL_LADDER },
  { match: /glm-5\.3-flash/i, efforts: FLASH_LADDER },
  { match: /deepseek-v4/i, efforts: FLASH_LADDER },
];

/** Model families that think but have no verified ladder — standard Codex ladder. */
const THINKING_FAMILY_PATTERN = /(glm|deepseek|kimi|qwen|minimax|gemini|claude)/i;

/** Verified non-thinking models on the current free roster. */
const NON_THINKING_PATTERN = /(^|\/)(mimo\/|upstage\/solar-pro4)/i;

export function freebuffModelCapabilities(modelId: string): FreebuffModelCapabilities {
  const tail = modelId.split("/").pop() ?? modelId;
  const known = THINKING_LADDERS.find(entry => entry.match.test(tail) || entry.match.test(modelId));
  if (known) return { reasoning: true, efforts: known.efforts };
  if (NON_THINKING_PATTERN.test(modelId)) return { reasoning: false, efforts: [] };
  if (THINKING_FAMILY_PATTERN.test(modelId)) return { reasoning: true, efforts: STANDARD_LADDER };
  return { reasoning: false, efforts: [] };
}

/**
 * Resolve the outgoing reasoning_effort for a model: undefined when the model does not
 * think (the field must be stripped entirely), the requested effort when supported, and
 * otherwise the nearest supported effort — ties clamp UP (effort is free; prefer quality).
 */
export function resolveReasoningEffort(modelId: string, requested?: string): ReasoningEffort | undefined {
  if (!requested || requested === "none" || requested === "minimal") return undefined;
  const { reasoning, efforts } = freebuffModelCapabilities(modelId);
  if (!reasoning || efforts.length === 0) return undefined;
  if ((efforts as string[]).includes(requested)) return requested as ReasoningEffort;
  const order: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
  const requestedIndex = order.indexOf(requested as ReasoningEffort);
  if (requestedIndex === -1) return efforts[efforts.length - 1];
  let best = efforts[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of efforts) {
    const distance = Math.abs(order.indexOf(candidate) - requestedIndex);
    if (distance < bestDistance || (distance === bestDistance && order.indexOf(candidate) > order.indexOf(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function buildFreebuffModel(modelId: string, contextWindow?: number): Record<string, unknown> {
  const capabilities = freebuffModelCapabilities(modelId);
  const window = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const displayName = `Freebuff — ${modelId.split("/").pop() ?? modelId}`;
  const levels = capabilities.reasoning
    ? capabilities.efforts.map(effort => ({ effort, description: EFFORT_DESCRIPTIONS[effort] }))
    : [{ effort: "low", description: "No deliberation — this model does not think." }];
  return {
    slug: modelId,
    display_name: displayName,
    description: capabilities.reasoning
      ? `${modelId} served free through the local Freebuff pool (thinking model).`
      : `${modelId} served free through the local Freebuff pool.`,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    // Default to the model's maximum deliberation — effort carries no extra quota here.
    default_reasoning_level: capabilities.reasoning ? capabilities.efforts[capabilities.efforts.length - 1]! : "low",
    supported_reasoning_levels: levels,
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: Math.round((AUTO_COMPACT_TOKEN_LIMIT / window) * 100),
    auto_compact_token_limit: AUTO_COMPACT_TOKEN_LIMIT,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
}

export function buildFreebuffModelCatalog(
  models: string[],
  contextWindow?: number,
): Record<string, unknown> {
  return {
    models: models.map(modelId => buildFreebuffModel(modelId, contextWindow)),
  };
}
