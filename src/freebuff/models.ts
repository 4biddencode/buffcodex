/**
 * Model registry — TS port of Freebuff2API's models.go, updated for Codebuff's current
 * free-agents.ts format.
 *
 * Upstream now declares `FREE_MODE_AGENT_MODELS: Record<string, Set<string>>` whose entries are
 * TypeScript identifier constants (FREEBUFF_GPT_5_6_LUNA_MODEL_ID, mimoModels.mimoV25, …) defined
 * across sibling files. We fetch those files, build a constant table from the simple
 * `export const X = 'value'` / object-literal definitions, and resolve every Set entry to a
 * concrete model id. Unresolvable entries are skipped with a warning rather than poisoning the
 * whole mapping. The legacy all-quoted format still parses (identical regex path).
 */

const SOURCE_BASE =
  "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants";
const SOURCE_FILES = [
  "free-agents.ts",
  "freebuff-models.ts",
  "freebuff-model-ids.ts",
  "model-config.ts",
];
const MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Upstream FREEBUFF_PREMIUM_SESSION_LIMIT — premium-pool sessions per Pacific day. */
export const PREMIUM_SESSION_LIMIT = 4;

export type ModelTier = "free" | "premium" | "limited" | "paused";

/** Used when every remote fetch fails on startup. Mirrors the 2026-09 free roster. */
const HARDCODED_FALLBACK: Record<string, string[]> = {
  "base2-free": [
    "minimax/minimax-m3",
    "openai/gpt-5.6-luna",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "mimo/mimo-v2.5",
  ],
  "base2-free-deepseek": ["deepseek/deepseek-v4-pro"],
  "base2-free-deepseek-flash": ["deepseek/deepseek-v4-flash"],
  "base2-free-mimo": ["mimo/mimo-v2.5"],
  "base2-free-luna": ["openai/gpt-5.6-luna"],
  "base2-free-solar-pro4": ["upstage/solar-pro4"],
  "base2-free-glm": ["z-ai/glm-5.2"],
  "base2-free-glm-5-3-flash": ["z-ai/glm-5.3-flash"],
  "base2-free-kimi-k3-eco": ["crof/kimi-k3-eco"],
  "base2-free-luna-es": ["openai/gpt-5.6-luna-es"],
  "base2-free-minimax-m3": ["minimax/minimax-m3"],
  "base2-free-fable": ["anthropic/claude-fable-5"],
};

interface NestedConstants {
  [objectName: string]: Record<string, string>;
}

/**
 * Build the constant table from TS sources:
 *   export const NAME = 'value'              (string, optionally on the next line)
 *   export const NAME = OTHER_NAME           (alias to another constant)
 *   export const OBJ = { key: 'value', … } as const
 */
export function buildConstantTable(sources: string[]): { strings: Record<string, string>; objects: NestedConstants } {
  const strings: Record<string, string> = {};
  const objects: NestedConstants = {};
  const combined = sources.join("\n");

  // Object literals first so their names are claimed before string-alias resolution.
  const objectPattern = /export const (\w+)\s*=\s*\{([^{}]*?)\}\s*as\s*const/g;
  for (const match of combined.matchAll(objectPattern)) {
    const name = match[1]!;
    const entries: Record<string, string> = {};
    for (const entry of match[2]!.matchAll(/(\w+)\s*:\s*'([^']*)'/g)) {
      entries[entry[1]!] = entry[2]!;
    }
    if (Object.keys(entries).length > 0) objects[name] = entries;
  }

  // String constants: export const NAME = 'value' — quote may sit on the next line, and a
  // type annotation (`: FreebuffModelId`) may sit between name and `=`.
  const stringPattern = /export const (\w+)(?:\s*:\s*[\w<>.\[\]]+)?\s*=\s*\n?\s*'([^']*)'/g;
  for (const match of combined.matchAll(stringPattern)) {
    strings[match[1]!] = match[2]!;
  }

  // Dotted aliases: export const NAME = OBJ.prop (type annotation tolerated).
  const dottedAliasPattern = /export const (\w+)(?:\s*:\s*[\w<>.\[\]]+)?\s*=\s*([A-Za-z_$][\w$]*)\.(\w+)\s*(?:[;\n]|$)/g;
  for (const match of combined.matchAll(dottedAliasPattern)) {
    const value = objects[match[2]!]?.[match[3]!];
    if (value !== undefined) strings[match[1]!] = value;
  }

  // Alias constants: export const NAME = OTHER_NAME (iterate to settle chains).
  const aliasPattern = /export const (\w+)(?:\s*:\s*[\w<>.\[\]]+)?\s*=\s*([A-Za-z_$][\w$]*)\s*(?:[;\n]|$)/g;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const match of combined.matchAll(aliasPattern)) {
      const name = match[1]!;
      const target = match[2]!;
      if (name === target || strings[name] !== undefined) continue;
      if (strings[target] !== undefined) {
        strings[name] = strings[target]!;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { strings, objects };
}

/** Resolve one Set entry: quoted literal | CONSTANT | object.prop. Returns null when unknown. */
export function resolveModelEntry(
  entry: string,
  strings: Record<string, string>,
  objects: NestedConstants,
): string | null {
  const token = entry.trim().replace(/,$/, "").trim();
  if (!token) return null;
  const quoted = token.match(/^'(.*)'$/);
  if (quoted) return quoted[1]!;
  if (/^[A-Za-z_$][\w$]*$/.test(token)) {
    const value = strings[token];
    return value !== undefined && value.includes("/") ? value : null;
  }
  const dotted = token.match(/^([A-Za-z_$][\w$]*)\.(\w+)$/);
  if (dotted) {
    const value = objects[dotted[1]!]?.[dotted[2]!];
    return value !== undefined && value.includes("/") ? value : null;
  }
  return null;
}

/** Extract FREE_MODE_AGENT_MODELS entries and resolve every model id. */
export function parseAllFreeModels(source: string): Record<string, string[]> {
  const { strings, objects } = buildConstantTable([source]);
  return parseFreeAgentsSection(source, strings, objects);
}

/** Full parse: free-agents.ts source + extra constant sources (freebuff-models.ts, …). */
export function parseFreeAgentsWithSources(
  agentSource: string,
  constantSources: string[],
): Record<string, string[]> {
  const { strings, objects } = buildConstantTable(constantSources);
  return parseFreeAgentsSection(agentSource, strings, objects);
}

function parseFreeAgentsSection(
  source: string,
  strings: Record<string, string>,
  objects: NestedConstants,
): Record<string, string[]> {
  // Only the FREE_MODE_AGENT_MODELS block defines free agent→model sets; slicing here keeps
  // unrelated `new Set([...])` declarations in the file from polluting the mapping.
  const sectionStart = source.indexOf("FREE_MODE_AGENT_MODELS");
  const section = sectionStart >= 0 ? source.slice(sectionStart) : source;
  const blockPattern = /'([^']+)'\s*:\s*new\s+Set\(\[([\s\S]*?)\]\)/g;
  const result: Record<string, string[]> = {};
  for (const match of section.matchAll(blockPattern)) {
    const agentId = match[1]!;
    const models: string[] = [];
    for (const rawEntry of match[2]!.split(",")) {
      const resolved = resolveModelEntry(rawEntry, strings, objects);
      if (resolved && !models.includes(resolved)) models.push(resolved);
      else if (!resolved && rawEntry.trim()) {
        console.warn(`model registry: unresolvable model entry ${rawEntry.trim()} for ${agentId}; skipping`);
      }
    }
    if (models.length > 0 && result[agentId]) {
      result[agentId] = [...new Set([...result[agentId]!, ...models])];
    } else if (models.length > 0) {
      result[agentId] = models;
    }
  }
  return result;
}

/**
 * Root agents are the free-mode session roots upstream requires (2026-09:
 * free_mode_invalid_agent_hierarchy — chat must run under a base2-free-* root run,
 * NOT a subagent like code-reviewer-*). Only concrete root TEMPLATES may serve models:
 * the bare 'base2-free' exists in FREE_MODE_AGENT_MODELS but has no agent template
 * upstream (runs started with it fail), and *-evals variants are test agents.
 */
const ROOT_AGENT_PATTERN = /^base\d+-free-/;
const NON_SERVING_AGENT_PATTERN = /-evals$/;

export function buildModelMapping(
  agentModels: Record<string, string[]>,
): { modelToAgent: Record<string, string>; allModels: string[] } {
  const modelAgents = new Map<string, string[]>();
  for (const [agentId, models] of Object.entries(agentModels)) {
    if (!ROOT_AGENT_PATTERN.test(agentId) || NON_SERVING_AGENT_PATTERN.test(agentId)) continue;
    for (const model of models) {
      const list = modelAgents.get(model);
      if (list) list.push(agentId);
      else modelAgents.set(model, [agentId]);
    }
  }
  const modelToAgent: Record<string, string> = {};
  const allModels: string[] = [];
  for (const [model, agents] of modelAgents) {
    // Deterministic: prefer the current base3-free-* CLI roots (the harness the shipped
    // binary runs — FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL), then alphabetical. Older
    // base2-free-* ids stay registered upstream but are the legacy family.
    const rank = (agentId: string) => (agentId.startsWith("base3-free-") ? 0 : 1);
    modelToAgent[model] = [...agents].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]!;
    allModels.push(model);
  }
  allModels.sort();
  return { modelToAgent, allModels };
}

export class ModelRegistry {
  private agentModels: Record<string, string[]> = {};
  private modelToAgent: Record<string, string> = {};
  private allModels: string[] = [];
  private tiers: ModelTierMap = FALLBACK_TIERS;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchFn: () => Promise<RegistryFetch>;

  constructor(fetchFn?: () => Promise<RegistryFetch>) {
    this.fetchFn = fetchFn ?? fetchFreeAgentsFromGitHub;
  }

  async start(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      console.warn(`model registry: initial fetch failed, loading hardcoded fallback: ${errorText(error)}`);
      this.loadFallback();
    }
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(error => console.warn(`model registry: refresh failed: ${errorText(error)}`));
    }, MODEL_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refresh(): Promise<void> {
    const { agents: fetched, sources } = await this.fetchFn();
    if (Object.keys(fetched).length === 0) throw new Error("no free agents found in source");
    // Tier lists come from the same sources; parse them BEFORE filtering so the fresh paused
    // set governs this refresh (upstream withdraws models by moving them onto that list).
    this.tiers = parseModelTiers(sources);
    // Paused models stay recognized upstream but are served to nobody — keep them out of the
    // Codex catalog so Codex never pins a row that can only fail at admission.
    const paused = this.tiers.paused;
    const all = Object.fromEntries(
      Object.entries(fetched).map(([agentId, models]) => [
        agentId,
        models.filter(modelId => !paused.has(modelId)),
      ]),
    );
    const { modelToAgent, allModels } = buildModelMapping(all);
    this.agentModels = all;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    console.info(`model registry: updated ${Object.keys(all).length} agents, ${allModels.length} models: ${allModels.join(", ")}`);
  }

  private loadFallback(): void {
    const { modelToAgent, allModels } = buildModelMapping(HARDCODED_FALLBACK);
    this.agentModels = HARDCODED_FALLBACK;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    console.info(`model registry: loaded fallback models: ${allModels.join(", ")}`);
  }

  models(): string[] {
    return [...this.allModels];
  }

  hasModel(model: string): boolean {
    return model in this.modelToAgent;
  }

  agentForModel(model: string): string | undefined {
    return this.modelToAgent[model];
  }

  agentIds(): string[] {
    return Object.keys(this.agentModels);
  }

  /** Model tier for notifications/catalog decoration; unknown models count as free. */
  tierFor(modelId: string): ModelTier {
    if (this.tiers.paused.has(modelId)) return "paused";
    if (this.tiers.limited.has(modelId)) return "limited";
    if (this.tiers.premium.has(modelId)) return "premium";
    return "free";
  }
}

export async function fetchFreeAgentsFromGitHub(): Promise<RegistryFetch> {
  const responses = await Promise.all(
    SOURCE_FILES.map(async name => {
      const response = await fetch(`${SOURCE_BASE}/${name}`, { headers: { Accept: "text/plain" } });
      return { name, source: response.ok ? await response.text() : "" };
    }),
  );
  const agentFile = responses.find(file => file.name === "free-agents.ts");
  if (!agentFile?.source) throw new Error("free-agents.ts could not be fetched");
  const constantSources = responses.filter(file => file.name !== "free-agents.ts").map(file => file.source);
  return {
    agents: parseFreeAgentsWithSources(agentFile.source, constantSources),
    sources: [agentFile.source, ...constantSources.filter(source => source.trim().length > 0)],
  };
}

export interface RegistryFetch {
  agents: Record<string, string[]>;
  /** Raw sources backing the agent map — tier lists are parsed from these. */
  sources: string[];
}

/** Parse a `export const NAME[?: T] = [entry, …] as const` array via the constant table. */
export function parseStringArrayConst(
  source: string,
  name: string,
  strings: Record<string, string>,
  objects: NestedConstants,
): string[] {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) return [];
  // Skip a type annotation (`: readonly string[]`) — its brackets must not end the scan.
  const equals = source.indexOf("=", start);
  if (equals === -1) return [];
  const open = source.indexOf("[", equals);
  if (open === -1) return [];
  // Array ends at the matching "]" — entries never contain brackets, so the first "]" works.
  const close = source.indexOf("]", open);
  if (close === -1) return [];
  const out: string[] = [];
  for (const rawEntry of source.slice(open + 1, close).split(",")) {
    const resolved = resolveModelEntry(rawEntry, strings, objects);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

export interface ModelTierMap {
  premium: Set<string>;
  limited: Set<string>;
  paused: Set<string>;
}

/** Extract the premium/limited/paused tier lists from the fetched sources. */
export function parseModelTiers(sources: string[]): ModelTierMap {
  const { strings, objects } = buildConstantTable(sources);
  const combined = sources.join("\n");
  return {
    premium: new Set(parseStringArrayConst(combined, "FREEBUFF_PREMIUM_MODEL_IDS", strings, objects)),
    limited: new Set(parseStringArrayConst(combined, "FREEBUFF_LIMITED_OFFER_MODEL_IDS", strings, objects)),
    paused: new Set(parseStringArrayConst(combined, "FREEBUFF_PAUSED_FREE_MODEL_IDS", strings, objects)),
  };
}

const FALLBACK_TIERS: ModelTierMap = {
  premium: new Set(["openai/gpt-5.6-luna", "upstage/solar-pro4"]),
  limited: new Set(["anthropic/claude-fable-5"]),
  paused: new Set([
    "minimax/minimax-m3",
    "deepseek/deepseek-v4-pro",
    "stealth/ox-alpha",
  ]),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
