/**
 * Codex model catalog — builds native-looking model rows for the Command Code Provider
 * API lineup so Codex's picker lists them with sane context windows, thinking flags,
 * and per-model reasoning-effort ladders (which also drive Codex's /model effort menu).
 *
 * Thinking detection is capability-driven: Claude/GPT/DeepSeek/GLM/Kimi/Qwen/MiniMax/
 * Gemini/Grok/Fable think; MiMo and Solar do not (web-UI verified 2026-09).
 */

const DEFAULT_CONTEXT_WINDOW = 190_000;
const AUTO_COMPACT_TOKEN_LIMIT = 170_000;

/** Efforts Codex accepts on the wire (parser also allows none/minimal for direct callers). */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCapabilities {
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
 * Verified thinking ladders keyed by upstream model-id substring. Order matters:
 * first match wins. Unknown-but-thinking families get the standard ladder.
 */
const THINKING_LADDERS: Array<{ match: RegExp; efforts: ReasoningEffort[] }> = [
  { match: /gpt-5\.6-luna/i, efforts: FULL_LADDER },
  { match: /gpt-5\.3-codex/i, efforts: FULL_LADDER },
  { match: /glm-5\.3-flash/i, efforts: FLASH_LADDER },
  { match: /deepseek-v4-flash/i, efforts: FLASH_LADDER },
];

const THINKING_FAMILY_PATTERN = /(glm|deepseek|kimi|qwen|minimax|gemini|claude|gpt-5|grok|fable|nemotron)/i;
const NON_THINKING_PATTERN = /(^|\/)(mimo|solar)/i;

export function modelCapabilities(upstreamId: string): ModelCapabilities {
  if (NON_THINKING_PATTERN.test(upstreamId)) return { reasoning: false, efforts: [] };
  const known = THINKING_LADDERS.find(entry => entry.match.test(upstreamId));
  if (known) return { reasoning: true, efforts: known.efforts };
  if (THINKING_FAMILY_PATTERN.test(upstreamId)) return { reasoning: true, efforts: STANDARD_LADDER };
  return { reasoning: false, efforts: [] };
}

/**
 * Resolve the outgoing reasoning_effort for a model: undefined when the model does not
 * think (the field must be stripped entirely), the requested effort when supported, and
 * otherwise the nearest supported effort — ties clamp UP (effort is free; prefer quality).
 */
export function resolveReasoningEffort(upstreamId: string, requested?: string): ReasoningEffort | undefined {
  if (!requested || requested === "none" || requested === "minimal") return undefined;
  const { reasoning, efforts } = modelCapabilities(upstreamId);
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

export interface ProviderModelInfo {
  /** Live context_length from /provider/v1/models when available. */
  contextLength?: number;
  display_name?: string;
}

/** Build one Codex catalog row for a Commancodex model. */
export function buildCommancodexModel(
  upstreamId: string,
  info?: ProviderModelInfo,
  contextWindow?: number,
): Record<string, unknown> {
  const capabilities = modelCapabilities(upstreamId);
  const window = info?.contextLength ?? contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const displayName = info?.display_name ?? upstreamId.split("/").pop() ?? upstreamId;
  const levels = capabilities.reasoning
    ? capabilities.efforts.map(effort => ({ effort, description: EFFORT_DESCRIPTIONS[effort] }))
    : [{ effort: "low", description: "No deliberation — this model does not think." }];
  const compactLimit = Math.min(AUTO_COMPACT_TOKEN_LIMIT, Math.floor(window * 0.9));
  return {
    slug: `commancodex/${upstreamId}`,
    display_name: `Commancodex — ${displayName}`,
    description: `${displayName} via the official Command Code Provider API.`,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: capabilities.reasoning ? capabilities.efforts[capabilities.efforts.length - 1]! : "low",
    supported_reasoning_levels: levels,
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: Math.round((compactLimit / window) * 100),
    auto_compact_token_limit: compactLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
}

export function buildCommancodexModelCatalog(
  models: string[],
  contextWindow?: number,
): Record<string, unknown> {
  return {
    models: models.map(upstreamId => buildCommancodexModel(upstreamId, undefined, contextWindow)),
  };
}

/** Used when the live /provider/v1/models fetch fails (offline, unvalidated key). */
export const FALLBACK_PROVIDER_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "z-ai/glm-5.3",
  "qwen/qwen3.8-max",
  "minimax/minimax-m3",
];
