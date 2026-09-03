/**
 * Buffcodex HTTP server — the Codex-facing Responses bridge.
 * Routes:
 *   GET  /v1/models                  → Codex model catalog (all free Freebuff models)
 *   POST /v1/responses               → Responses (streaming SSE or JSON) via the Freebuff pool
 *   GET  /healthz                    → liveness + account snapshots
 *   GET  /usage                      → per-account remaining/used usage (launcher panel)
 *   POST /accounts/validate          → validate an auth token without saving it
 */
import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { createFreebuffAdapter } from "./adapters/freebuff";
import { buildResponseJSON, bridgeToResponsesSSE } from "./bridge";
import type { BuffcodexConfig } from "./config";
import { maskToken } from "./config";
import { expandPreviousResponseInput, rememberResponseState } from "./responses/state";
import { parseRequest } from "./responses/parser";
import { UpstreamClient } from "./freebuff/upstream";
import { AccountPool, FreebuffAccount, errorText } from "./freebuff/pool";
import { renderDashboard } from "./dashboard";
import { ModelRegistry, PREMIUM_SESSION_LIMIT } from "./freebuff/models";
import { buildFreebuffModelCatalog } from "./models-catalog";
import { COMPACT_PROMPT } from "./responses/compaction";
import { readJsonRequestBody } from "./http-body";
import { namespacedToolName } from "./types";

export interface Runtime {
  config: BuffcodexConfig;
  client: UpstreamClient;
  pool: AccountPool;
  registry: ModelRegistry;
  adapter: ProviderAdapter;
  startedAt: number;
  /** Invoked after a live account add/remove so the CLI can persist config. */
  onAccountsChanged?: () => void;
  /** Incremental /usage notifications: dashboard polls only receive the new slice. */
  usageRequestState: { lastPollMs: number };
}

export function createRuntime(config: BuffcodexConfig): Runtime {
  // Tier parsing shares the registry's source files; the registry consumes tiers on refresh.
  const client = new UpstreamClient({
    baseUrl: config.upstreamBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
  });
  const accounts = config.authTokens.map((token, index) => new FreebuffAccount({
    name: `account-${index + 1}`,
    token,
    maskedToken: maskToken(token),
    client,
    rotationIntervalMs: config.rotationIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
  }));
  const pool = new AccountPool(accounts);
  const registry = new ModelRegistry();
  const adapter = createFreebuffAdapter({
    pool,
    resolveAgentId: modelId => registry.agentForModel(modelId) ?? "base2-free",
    resolveModelTier: modelId => registry.tierFor(modelId),
  });
  return { config, client, pool, registry, adapter, startedAt: Date.now(), usageRequestState: { lastPollMs: Date.now() } };
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

function authorized(request: Request, config: BuffcodexConfig): boolean {
  if (config.apiKeys.length === 0) return true;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const apiKey = request.headers.get("x-api-key")?.trim() || bearer;
  return apiKey.length > 0 && config.apiKeys.includes(apiKey);
}

/** Loopback clients (local Codex, local dashboard) are always trusted — no API key. */
export function isLoopbackAddress(remoteAddress?: string | null): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

/**
 * API keys gate non-loopback clients that would spend accounts or mutate configuration
 * (POSTs, Codex-facing /v1/*). Read-only GETs stay open for LAN dashboards; nothing
 * sensitive is in them — tokens are always masked in /usage. Loopback never needs a key,
 * so locally-installed Codex works without environment setup (GUI apps cannot read
 * shell rc files, so env-key auth is not viable for them).
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

async function handleModels(runtime: Runtime): Promise<Response> {
  const catalog = buildFreebuffModelCatalog(registryModels(runtime), runtime.config.contextWindow);
  const body = JSON.stringify(catalog);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "etag": `W/\"${createHash("sha256").update(body).digest("base64url")}\"`,
    },
  });
}

function registryModels(runtime: Runtime): string[] {
  const models = runtime.registry.models();
  return models.length > 0 ? models : ["minimax/minimax-m2.7", "z-ai/glm-5.1"];
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
  if (!runtime.registry.hasModel(parsed.modelId)) {
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

function accountSnapshots(runtime: Runtime) {
  return runtime.pool.snapshots().map(snapshot => ({
    name: snapshot.name,
    maskedToken: snapshot.maskedToken,
    status: snapshot.coolingDownUntilMs > Date.now()
      ? "cooldown"
      : snapshot.session?.status === "queued"
        ? "queued"
        : snapshot.lastError
          ? "error"
          : "ok",
    lastError: snapshot.lastError || undefined,
    session: snapshot.session ? { status: snapshot.session.status, position: snapshot.session.position, queueDepth: snapshot.session.queueDepth } : undefined,
    runs: snapshot.runs.map(run => ({ agentId: run.agentId, inflight: run.inflight, requestCount: run.requestCount })),
    usage: {
      requestCount: snapshot.usage.requestCount,
      inputTokens: snapshot.usage.inputTokens,
      outputTokens: snapshot.usage.outputTokens,
      totalTokens: snapshot.usage.totalTokens,
      lastRequestAtMs: snapshot.usage.lastRequestAtMs,
    },
  }));
}

async function handleUsage(runtime: Runtime): Promise<Response> {
  const sinceMs = runtime.usageRequestState.lastPollMs;
  runtime.usageRequestState.lastPollMs = Date.now();
  return json({
    startedAtMs: runtime.startedAt,
    accounts: accountSnapshots(runtime),
    notifications: runtime.pool.recentNotifications(sinceMs),
    premiumSessionLimit: PREMIUM_SESSION_LIMIT,
  });
}

async function handleHealthz(runtime: Runtime): Promise<Response> {
  return json({
    ok: true,
    startedAtMs: runtime.startedAt,
    models: registryModels(runtime).length,
    accounts: accountSnapshots(runtime),
  });
}

/**
 * Live account management: add/remove accounts while the bridge keeps serving.
 * Persistence goes through the optional store callback (CLI wiring keeps config atomic).
 */
async function handleAccountsChange(request: Request, runtime: Runtime): Promise<Response> {
  const body = await request.json().catch(() => null) as { action?: unknown; token?: unknown; name?: unknown } | null;
  const action = typeof body?.action === "string" ? body.action : "";
  if (action === "add") {
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return errorResponse(400, "token is required");
    const existing = runtime.pool.listAccounts();
    if (existing.some(account => account.maskedToken === maskToken(token))) {
      return errorResponse(409, "that account is already configured");
    }
    const probe = new UpstreamClient({ baseUrl: runtime.config.upstreamBaseUrl, requestTimeoutMs: 20_000 });
    try {
      await probe.createOrRefreshSession(token);
    } catch (error) {
      return json({ ok: false, error: errorText(error) }, 400);
    }
    const name = `account-${existing.length + 1}`;
    runtime.pool.addAccount(new FreebuffAccount({
      name,
      token,
      maskedToken: maskToken(token),
      client: runtime.client,
      rotationIntervalMs: runtime.config.rotationIntervalMs,
      requestTimeoutMs: runtime.config.requestTimeoutMs,
    }));
    runtime.onAccountsChanged?.();
    return json({ ok: true, name, accounts: runtime.pool.size });
  }
  if (action === "remove") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return errorResponse(400, "name is required");
    if (runtime.pool.size <= 1) return errorResponse(409, "cannot remove the last account");
    const removed = await runtime.pool.removeAccount(name);
    if (!removed) return errorResponse(404, `no such account: ${name}`);
    runtime.onAccountsChanged?.();
    return json({ ok: true, accounts: runtime.pool.size });
  }
  return errorResponse(400, "action must be add or remove");
}

/** Validate an upstream token without persisting it. */
async function handleValidateToken(request: Request, runtime: Runtime): Promise<Response> {
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) return errorResponse(400, "token is required");
  try {
    const probe = new UpstreamClient({
      baseUrl: runtime.config.upstreamBaseUrl,
      requestTimeoutMs: 15_000,
    });
    const session = await probe.createOrRefreshSession(token);
    return json({
      valid: true,
      sessionStatus: session.status,
      ...(session.instanceId ? { instanceId: session.instanceId } : {}),
    });
  } catch (error) {
    return json({ valid: false, error: errorText(error) });
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
  url: URL,
): Promise<Response> {
  if (path === "/" && request.method === "GET") return new Response(renderDashboard(runtime.config.port), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  if (path === "/v1/models" && request.method === "GET") return await handleModels(runtime);
  if (path === "/v1/responses" && request.method === "POST") return await handleResponses(request, runtime);
  if (path === "/healthz" && request.method === "GET") return await handleHealthz(runtime);
  if (path === "/usage" && request.method === "GET") return await handleUsage(runtime);
  if (path === "/notifications" && request.method === "GET") {
    return json({ notifications: runtime.pool.recentNotifications() });
  }
  if (path === "/accounts" && request.method === "POST") return await handleAccountsChange(request, runtime);
  if (path === "/accounts/validate" && request.method === "POST") return await handleValidateToken(request, runtime);
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
  console.info(`buffcodex listening on http://${runtime.config.host}:${server.port}/v1`);
  return {
    port: runtime.config.port,
    stop: () => server.stop(true),
  };
}
