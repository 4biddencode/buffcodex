/**
 * Commandcodex model multiplexer — does EXACTLY what codex-chatgpt-web's
 * augmentNativeModelCatalog + buildChatGptWebModel do, just one hop further out:
 *
 * 1. Fetch the chatgpt-web bridge's /v1/models (the augmented native catalog), passing
 *    the caller's Bearer through — untouched, byte for byte.
 * 2. Select a native template row (list-visible, with reasoning metadata).
 * 3. Build one commancodex row per model: a structuredClone of the template with
 *    identity/reasoning/context overrides, tool_mode/upgrade null, empty service tiers,
 *    comp_hash + availability_nux deleted.
 * 4. Return { ...catalog, models: [...catalog.models, ...commancodexRows] } — the full
 *    catalog object preserved, rows only appended.
 *
 * /v1/responses is routed by model slug: commancodex/* → 17999 (this bridge, official
 * Command Code Provider API), everything else → 17841 (chatgpt-web).
 */

const MUXER_PORT = 17850;

const CHATGPT_WEB_BRIDGE = "http://127.0.0.1:17841";
const COMMANCEX_BRIDGE = "http://127.0.0.1:17999";

type JsonObject = Record<string, unknown>;

function isCommancodexModel(slug: unknown): boolean {
  return typeof slug === "string" && slug.startsWith("commancodex/");
}

function slugOf(model: unknown): string | undefined {
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const candidate = (model as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

async function fetchJson(url: string, authorization?: string, timeoutMs = 8_000): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(authorization ? { headers: { authorization } } : {}),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ── Mirror of codex-chatgpt-web model-catalog.ts ─────────────────────────────

function nativeTemplateCandidate(model: JsonObject): boolean {
  const modelSlug = slugOf(model);
  if (!modelSlug || modelSlug.startsWith("chatgpt-web/") || modelSlug.startsWith("commancodex/")) return false;
  if (model.visibility !== "list") return false;
  if (!Array.isArray(model.supported_reasoning_levels)) return false;
  return true;
}

function selectNativeTemplate(models: unknown[]): JsonObject {
  const candidates = models.filter(model =>
    model && typeof model === "object" && !Array.isArray(model) && nativeTemplateCandidate(model as JsonObject),
  ) as JsonObject[];
  const template = candidates[0];
  if (template) return template;
  throw new Error("native models response has no list-visible model with reasoning metadata");
}

/** Per-model ladder (web-UI verified). Default = the model's maximum deliberation. */
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

/** Mirror of buildChatGptWebModel: structuredClone(template) + identity overrides. */
function buildCommancodexModelRow(templateValue: JsonObject, slug: string): JsonObject {
  const template = structuredClone(templateValue);
  const upstreamId = slug.slice("commancodex/".length);
  const ladder = commancodexLadder(upstreamId);
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
    context_window: DEFAULT_CONTEXT_WINDOW,
    max_context_window: DEFAULT_CONTEXT_WINDOW,
    effective_context_window_percent: Math.round((AUTO_COMPACT_TOKEN_LIMIT / DEFAULT_CONTEXT_WINDOW) * 100),
    auto_compact_token_limit: AUTO_COMPACT_TOKEN_LIMIT,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

// ── Muxed catalog ─────────────────────────────────────────────────────────────

const NATIVE_CACHE_PATH = `${process.env.HOME ?? ""}/.commandcodex/mux-native-catalog.json`;

function saveNativeCache(catalog: unknown): void {
  try {
    require("node:fs").mkdirSync(require("node:path").dirname(NATIVE_CACHE_PATH), { recursive: true });
    require("node:fs").writeFileSync(NATIVE_CACHE_PATH, JSON.stringify(catalog));
  } catch { /* best effort */ }
}

function loadNativeCache(): unknown | null {
  try {
    return JSON.parse(require("node:fs").readFileSync(NATIVE_CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function mergeCatalog(catalog: JsonObject, commancodexModels: string[]): unknown {
  const models = catalog.models as unknown[];
  const template = selectNativeTemplate(models);
  const existing = new Set(models.map(slugOf).filter(Boolean) as string[]);
  const appended = commancodexModels
    .filter(slug => !existing.has(slug))
    .map(slug => buildCommancodexModelRow(template, slug));
  return { ...catalog, models: [...models, ...appended] };
}

async function muxedCatalog(authorization?: string, search = ""): Promise<unknown> {
  // The passthrough requires Codex's client_version query param — forward the caller's
  // search string verbatim.
  const native = await fetchJson(`${CHATGPT_WEB_BRIDGE}/v1/models${search}`, authorization);
  const ours = await fetchJson(`${COMMANCEX_BRIDGE}/v1/models`);
  const commancodexModels = ((ours as { models?: unknown[] } | null)?.models ?? [])
    .map(row => slugOf(row))
    .filter((slug): slug is string => typeof slug === "string" && slug.startsWith("commancodex/"));

  if (native && typeof native === "object" && Array.isArray((native as JsonObject).models)) {
    saveNativeCache(native);
    return mergeCatalog(structuredClone(native) as JsonObject, commancodexModels);
  }

  // Native fetch failed (stale/expired Bearer or bridge down): use the last-good cache.
  const cached = loadNativeCache();
  if (cached && typeof cached === "object" && Array.isArray((cached as JsonObject).models)) {
    return mergeCatalog(structuredClone(cached) as JsonObject, commancodexModels);
  }

  // Last resort: embedded schema template (proven accepted by Codex 0.152).
  const { default: embeddedTemplate } = await import("./schema-template.json");
  return {
    models: commancodexModels.map(slug => buildCommancodexModelRow(embeddedTemplate as JsonObject, slug)),
  };
}

// ── Response routing ──────────────────────────────────────────────────────────

/**
 * Codex sends zstd-compressed request bodies (content-encoding: zstd), so the raw bytes
 * must be decompressed before the JSON can be peeked at. Undecodable bodies route to the
 * chatgpt-web bridge (safe default — commancodex turns are opt-in by model slug).
 */
function pickUpstream(body: Uint8Array | undefined, headers: Headers, path: string): string {
  if (path !== "/v1/responses" || body === undefined || body.byteLength === 0) return CHATGPT_WEB_BRIDGE;
  try {
    const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
    let jsonText: string;
    if (encoding.includes("zstd")) {
      if (typeof Bun.zstdDecompressSync !== "function") return CHATGPT_WEB_BRIDGE;
      jsonText = new TextDecoder().decode(Bun.zstdDecompressSync(body));
    } else {
      jsonText = new TextDecoder().decode(body);
    }
    const parsed = JSON.parse(jsonText) as { model?: unknown };
    return isCommancodexModel(parsed.model) ? COMMANCEX_BRIDGE : CHATGPT_WEB_BRIDGE;
  } catch {
    return CHATGPT_WEB_BRIDGE;
  }
}

async function forward(
  request: Request,
  target: string,
  path: string,
  search: string,
  bodyBytes: Uint8Array | undefined,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  // content-encoding is KEPT: the body bytes are forwarded exactly as received.
  const upstream = await fetch(`${target}${path}${search}`, {
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
<p>Codex points at <code>http://127.0.0.1:${port}/v1</code> — chatgpt-web <em>and</em> Commancodex models.</p>
<ul>
<li><code>127.0.0.1:17841</code> — chatgpt-web bridge (catalog passed through untouched)</li>
<li><code>127.0.0.1:17999</code> — commancodex bridge (official Command Code Provider API)</li>
<li><code>127.0.0.1:${port}</code> — this muxer (native catalog + appended commancodex rows)</li>
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
      const catalog = await muxedCatalog(request.headers.get("authorization") ?? undefined, url.search);
      console.info(`${new Date().toISOString()} GET /v1/models -> merged catalog`);
      return Response.json(catalog);
    }
    if (path.startsWith("/v1/")) {
      const bodyBytes = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      const target = pickUpstream(bodyBytes, request.headers, path);
      const response = await forward(request, target, path, url.search, bodyBytes);
      console.info(`${new Date().toISOString()} ${request.method} ${path} -> ${target}:${response.status}`);
      return response;
    }
    return new Response("not found", { status: 404 });
  },
});

console.info(`commandcodex muxer listening on http://127.0.0.1:${server.port}/v1`);
console.info(`  appends commancodex rows to the catalog of ${CHATGPT_WEB_BRIDGE}; turns route by model`);
