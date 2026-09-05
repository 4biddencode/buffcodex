/**
 * Commandcodex model multiplexer — app-facing catalog + router. chatgpt-web is gone;
 * the muxer is self-sufficient:
 *
 * 1. Fetch the bridge's /v1/models (commancodex/* rows).
 * 2. Build app-ready rows from the embedded native schema template (proven accepted by
 *    Codex 0.152) — identity/reasoning overrides, tool_mode/upgrade null, comp_hash and
 *    availability_nux deleted.
 * 3. Serve { models: [...rows] }; every /v1/* request proxies to the bridge (:17999).
 */

const MUXER_PORT = 17850;

const BRIDGE = "http://127.0.0.1:17999";

type JsonObject = Record<string, unknown>;

function slugOf(model: unknown): string | undefined {
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const candidate = (model as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ── App-ready row builder (mirror of codex-chatgpt-web buildChatGptWebModel) ──

/** Per-model ladder. Default = the model's maximum deliberation. */
const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: "Light deliberation. Fast, inexpensive replies.",
  medium: "Balanced deliberation.",
  high: "More deliberation. Slower replies.",
  xhigh: "Very deep deliberation. Much slower replies.",
  max: "Maximum deliberation this model allows.",
  none: "No deliberation — this model does not think.",
};

const FULL_LADDER = ["low", "medium", "high", "xhigh", "max"];
const FLASH_LADDER = ["low", "high", "max"];
const STANDARD_LADDER = ["low", "medium", "high"];

const THINKING_LADDERS: Array<{ match: RegExp; efforts: string[] }> = [
  { match: /gpt-5\.6-luna/i, efforts: FULL_LADDER },
  { match: /gpt-5\.3-codex/i, efforts: FULL_LADDER },
  { match: /glm-5\.3-flash/i, efforts: FLASH_LADDER },
  { match: /deepseek-v4-flash/i, efforts: FLASH_LADDER },
];
const THINKING_FAMILY_PATTERN = /(glm|deepseek|kimi|qwen|minimax|gemini|claude|gpt-5|grok|fable|nemotron)/i;
const NON_THINKING_PATTERN = /(^|\/)(mimo|solar)/i;

function commancodexLadder(upstreamId: string): string[] {
  const known = THINKING_LADDERS.find(entry => entry.match.test(upstreamId));
  if (known) return known.efforts;
  if (NON_THINKING_PATTERN.test(upstreamId)) return ["none"];
  if (THINKING_FAMILY_PATTERN.test(upstreamId)) return STANDARD_LADDER;
  return ["none"];
}

const DEFAULT_CONTEXT_WINDOW = 190_000;
const AUTO_COMPACT_TOKEN_LIMIT = 170_000;

/** Live context_length (from the bridge's provider catalog), if advertised. */
function contextWindowOf(upstreamId: string, models: JsonObject[]): number | undefined {
  const row = models.find(model => slugOf(model) === `commancodex/${upstreamId}`);
  const window = row?.context_window;
  return typeof window === "number" && window > 0 ? window : undefined;
}

function buildAppModelRow(templateValue: JsonObject, slug: string, bridgeModels: JsonObject[]): JsonObject {
  const template = structuredClone(templateValue);
  const upstreamId = slug.slice("commancodex/".length);
  const ladder = commancodexLadder(upstreamId);
  const window = contextWindowOf(upstreamId, bridgeModels) ?? DEFAULT_CONTEXT_WINDOW;
  const compactLimit = Math.min(AUTO_COMPACT_TOKEN_LIMIT, Math.floor(window * 0.9));
  const displayName = `Commancodex — ${upstreamId.split("/").pop() ?? upstreamId}`;
  const thinking = !(ladder.length === 1 && ladder[0] === "none");
  const defaultLevel = thinking ? ladder[ladder.length - 1]! : "low";
  const model: JsonObject = {
    ...template,
    slug,
    display_name: displayName,
    description: thinking
      ? `${upstreamId} via the official Command Code Provider API (thinking model).`
      : `${upstreamId} via the official Command Code Provider API.`,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: true,
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: defaultLevel,
    supported_reasoning_levels: ladder.map(effort => ({ effort, description: EFFORT_DESCRIPTIONS[effort] ?? displayName })),
    context_window: window,
    max_context_window: window,
    effective_context_window_percent: Math.round((compactLimit / window) * 100),
    auto_compact_token_limit: compactLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

// ── Muxed catalog ─────────────────────────────────────────────────────────────

const CATALOG_CACHE_PATH = `${process.env.HOME ?? ""}/.commandcodex/mux-catalog.json`;

function saveCache(catalog: unknown): void {
  try {
    require("node:fs").mkdirSync(require("node:path").dirname(CATALOG_CACHE_PATH), { recursive: true });
    require("node:fs").writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(catalog));
  } catch { /* best effort */ }
}

function loadCache(): unknown | null {
  try {
    return JSON.parse(require("node:fs").readFileSync(CATALOG_CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function muxedCatalog(): Promise<unknown> {
  const ours = await fetchJson(`${BRIDGE}/v1/models`);
  const bridgeModels = ((ours as { models?: unknown[] } | null)?.models ?? [])
    .filter((row): row is JsonObject => Boolean(row) && typeof row === "object" && !Array.isArray(row));
  const slugs = bridgeModels
    .map(row => slugOf(row))
    .filter((slug): slug is string => typeof slug === "string" && slug.startsWith("commancodex/"));

  if (slugs.length === 0) {
    // Bridge down: serve the last-good catalog so the app keeps working.
    const cached = loadCache();
    if (cached && typeof cached === "object" && Array.isArray((cached as JsonObject).models)) return cached;
  }

  const { default: embeddedTemplate } = await import("./schema-template.json");
  const catalog = {
    models: slugs.map(slug => buildAppModelRow(embeddedTemplate as JsonObject, slug, bridgeModels)),
  };
  if (slugs.length > 0) saveCache(catalog);
  return catalog;
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

async function forward(
  request: Request,
  path: string,
  search: string,
  bodyBytes: Uint8Array | undefined,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  // content-encoding is KEPT: the body bytes are forwarded exactly as received.
  const upstream = await fetch(`${BRIDGE}${path}${search}`, {
    method: request.method,
    headers,
    ...(bodyBytes !== undefined ? { body: bodyBytes as unknown as BodyInit } : {}),
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("transfer-encoding");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function muxerDashboard(port: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>commandcodex muxer</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:560px;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22}
h1{margin:0 0 8px;font-size:20px}code{background:#21262d;padding:2px 6px;border-radius:4px;font-size:13px}
ul{line-height:1.9;color:#8b949e}</style></head><body><div class="card">
<h1>commandcodex model multiplexer</h1>
<p>Codex points at <code>http://127.0.0.1:${port}/v1</code> — every model is a Commancodex row.</p>
<ul>
<li><code>127.0.0.1:17999</code> — commandcodex bridge (official Command Code Provider API)</li>
<li><code>127.0.0.1:${port}</code> — this muxer (app-ready catalog + proxy)</li>
</ul></div></body></html>`;
}

const server = Bun.serve({
  port: MUXER_PORT,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" && request.method === "GET") {
      return new Response(muxerDashboard(MUXER_PORT), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/v1/models" && request.method === "GET") {
      const catalog = await muxedCatalog();
      console.info(`${new Date().toISOString()} GET /v1/models -> app catalog`);
      return Response.json(catalog);
    }
    if (path.startsWith("/v1/")) {
      const bodyBytes = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      const response = await forward(request, path, url.search, bodyBytes);
      console.info(`${new Date().toISOString()} ${request.method} ${path} -> ${BRIDGE}:${response.status}`);
      return response;
    }
    return new Response("not found", { status: 404 });
  },
});

console.info(`commandcodex muxer listening on http://127.0.0.1:${server.port}/v1`);
console.info(`  app-ready commancodex catalog; all turns proxy to ${BRIDGE}`);
