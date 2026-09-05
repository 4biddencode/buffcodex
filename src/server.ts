/**
 * Commandcodex HTTP server — the Codex-facing Responses bridge over the OFFICIAL
 * Command Code Provider API (key-authenticated; no account pool, no bans).
 * Routes:
 *   GET  /v1/models        → Codex model catalog (commancodex/* rows)
 *   POST /v1/responses     → Responses (streaming SSE or JSON) via the Provider API
 *   GET  /healthz          → liveness + model count
 *   POST /key/validate     → validate a Provider API key without saving it
 */
import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { createCommancodexAdapter } from "./commancodex";
import { CommancodexClient } from "./commancodex/client";
import { errorText } from "./lib/errors";
import { buildResponseJSON, bridgeToResponsesSSE } from "./bridge";
import type { CommandCodexConfig } from "./config";
import { expandPreviousResponseInput, rememberResponseState } from "./responses/state";
import { parseRequest } from "./responses/parser";
import {
  buildCommancodexModelCatalog,
  buildCommancodexModel,
  FALLBACK_PROVIDER_MODELS,
} from "./models-catalog";
import { COMPACT_PROMPT } from "./responses/compaction";
import { readJsonRequestBody } from "./http-body";
import { namespacedToolName } from "./types";

export interface Runtime {
  config: CommandCodexConfig;
  client: CommancodexClient;
  adapter: ProviderAdapter;
  /** Live provider rows (id, name, context_length); empty = fallback rows. */
  providerRows: Array<{ id: string; name?: string; context_length?: number }>;
  startedAt: number;
}

export function createRuntime(config: CommandCodexConfig): Runtime {
  const client = new CommancodexClient({
    apiKey: config.apiKey,
    ...(config.providerBaseUrl ? { baseUrl: config.providerBaseUrl } : {}),
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
  });
  const adapter = createCommancodexAdapter({
    client,
    resolveUpstreamModel: modelId => modelId.startsWith("commancodex/") ? modelId.slice("commancodex/".length) : modelId,
  });
  return {
    config,
    client,
    adapter,
    providerRows: [],
    startedAt: Date.now(),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(status: number, message: string, type = "invalid_request_error"): Response {
  return json({ error: { message, type, code: type } }, status);
}

function authorized(request: Request, config: CommandCodexConfig): boolean {
  if (config.apiKeys.length === 0) return true;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const apiKey = request.headers.get("x-api-key")?.trim() || bearer;
  return apiKey.length > 0 && config.apiKeys.includes(apiKey);
}

/** Loopback clients (local Codex) are always trusted — no API key. */
export function isLoopbackAddress(remoteAddress?: string | null): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

/**
 * API keys gate non-loopback clients. Read-only GETs stay open for LAN dashboards;
 * loopback never needs a key, so locally-installed Codex works without env setup.
 */
function requiresApiKey(request: Request, runtime: Runtime, remoteAddress?: string | null): boolean {
  if (isLoopbackAddress(remoteAddress)) return false;
  if (runtime.config.apiKeys.length === 0) return false;
  if (request.method !== "GET") return true;
  return new URL(request.url).pathname.startsWith("/v1/");
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

/** Codex rows from live provider data, else the static fallback. */
function providerModels(runtime: Runtime): string[] {
  return runtime.providerRows.length > 0
    ? runtime.providerRows.map(row => row.id)
    : FALLBACK_PROVIDER_MODELS;
}

async function handleModels(runtime: Runtime): Promise<Response> {
  const rows = runtime.providerRows.length > 0
    ? runtime.providerRows.map(row => buildCommancodexModel(row.id, { contextLength: row.context_length, ...(row.name ? { display_name: row.name } : {}) }))
    : FALLBACK_PROVIDER_MODELS.map(id => buildCommancodexModel(id, undefined, runtime.config.contextWindow));
  const catalog = { models: rows };
  const body = JSON.stringify(catalog);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "etag": `W/\"${createHash("sha256").update(body).digest("base64url")}\"`,
    },
  });
}

async function handleResponses(request: Request, runtime: Runtime): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(request);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "Request body must be valid JSON");
  }
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  try {
    parsed = parseRequest(expanded);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }
  if (!supportsModel(runtime, parsed.modelId)) {
    return errorResponse(400, `unsupported model ${JSON.stringify(parsed.modelId)}`);
  }
  if (parsed._compactionRequest) {
    // Remote compaction v2: run the model as a plain summarizer and emit exactly one
    // synthetic compaction item (see src/responses/compaction.ts).
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const queue = new EventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const run = async () => {
    try {
      await runtime.adapter.runTurn!(parsed, { headers: request.headers, abortSignal: abort.signal }, event => queue.push(event));
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = parsed.modelId;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        ...(Number.isFinite(runtime.config.requestTimeoutMs)
          ? { stallTimeoutSec: Math.ceil(runtime.config.requestTimeoutMs / 1000) }
          : {}),
        ...(parsed._compactionRequest ? { compaction: true } : {
          onCompletedResponse: (response: Record<string, unknown>) => rememberResponseState(parsed._rawBody, response, { force: true }),
        }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const responseBody = buildResponseJSON(events, responseModel, {
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(parsed._compactionRequest ? { compaction: true } : {}),
  });
  if (!parsed._compactionRequest) {
    rememberResponseState(parsed._rawBody, responseBody, { force: true });
  }
  return Response.json(responseBody);
}

/** Minimal async event queue with the surface bridge.ts expects. */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    for (const resolve of this.resolvers.splice(0)) resolve();
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) resolve();
  }

  async collect(): Promise<T[]> {
    const out: T[] = [];
    for (;;) {
      while (this.items.length > 0) out.push(this.items.shift()!);
      if (this.closed) return out;
      await new Promise<void>(resolve => this.resolvers.push(resolve));
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor = 0;
    const self = this;
    return {
      async next(): Promise<IteratorResult<T>> {
        while (cursor >= self.items.length) {
          if (self.closed) return { done: true, value: undefined };
          await new Promise<void>(resolve => self.resolvers.push(resolve));
        }
        const value = self.items[cursor++]!;
        return { done: false, value };
      },
    };
  }
}

async function handleHealthz(runtime: Runtime): Promise<Response> {
  return json({
    ok: true,
    startedAtMs: runtime.startedAt,
    models: providerModels(runtime).length,
    provider: "commandcode.ai",
    liveCatalog: runtime.providerRows.length > 0,
  });
}

/** Validate a Provider API key without persisting it. */
async function handleValidateKey(request: Request, runtime: Runtime): Promise<Response> {
  const body = await request.json().catch(() => null) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return errorResponse(400, "apiKey is required");
  const probe = new CommancodexClient({
    apiKey,
    ...(runtime.config.providerBaseUrl ? { baseUrl: runtime.config.providerBaseUrl } : {}),
    requestTimeoutMs: 15_000,
  });
  try {
    const models = await probe.listModels();
    return json({ valid: true, models: models.length });
  } catch (error) {
    return json({ valid: false, error: errorText(error) });
  }
}

/**
 * Fetch the live Provider API catalog into the runtime. Called at serve startup and
 * every 10 minutes; failure keeps the last list (or the static fallback rows).
 */
export async function refreshProviderModels(runtime: Runtime): Promise<number> {
  try {
    const rows = (await runtime.client.listModels())
      .filter(row => typeof row.id === "string" && row.id.length > 0);
    if (rows.length > 0) runtime.providerRows = rows;
    return runtime.providerRows.length;
  } catch (error) {
    console.warn(`provider models refresh failed: ${errorText(error)}`);
    return runtime.providerRows.length;
  }
}

export async function handleRequest(
  request: Request,
  runtime: Runtime,
  remoteAddress?: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (requiresApiKey(request, runtime, remoteAddress) && !authorized(request, runtime.config)) {
    return errorResponse(401, "invalid proxy api key", "authentication_error");
  }
  try {
    const response = await routeRequest(request, runtime, path, url);
    // Access log: method, path, status, client — essential for debugging client wiring.
    console.info(`${new Date().toISOString()} ${remoteAddress ?? "?"} ${request.method} ${path} -> ${response.status}`);
    return response;
  } catch (error) {
    console.error(`request ${request.method} ${path} failed: ${errorText(error)}`);
    return errorResponse(500, error instanceof Error ? error.message : String(error), "server_error");
  }
}

async function routeRequest(
  request: Request,
  runtime: Runtime,
  path: string,
  _url: URL,
): Promise<Response> {
  if (path === "/" && request.method === "GET") {
    return json({ ok: true, hint: "commandcodex — see /v1/models, /healthz" });
  }
  if (path === "/v1/models" && request.method === "GET") return await handleModels(runtime);
  if (path === "/v1/responses" && request.method === "POST") return await handleResponses(request, runtime);
  if (path === "/healthz" && request.method === "GET") return await handleHealthz(runtime);
  if (path === "/key/validate" && request.method === "POST") return await handleValidateKey(request, runtime);
  return errorResponse(404, `not found: ${path}`);
}

export function startServer(runtime: Runtime): { stop(): Promise<void>; port: number } {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: runtime.config.port,
    hostname: runtime.config.host,
    async fetch(request) {
      const ip = server.requestIP(request);
      return handleRequest(request, runtime, ip?.address);
    },
  });
  console.info(`commandcodex listening on http://${runtime.config.host}:${server.port}/v1`);
  return {
    port: runtime.config.port,
    stop: () => server.stop(true),
  };
}

function supportsModel(runtime: Runtime, modelId: string): boolean {
  if (!modelId.startsWith("commancodex/")) return false;
  return providerModels(runtime).includes(modelId.slice("commancodex/".length));
}
