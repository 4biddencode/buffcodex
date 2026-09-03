/**
 * Freebuff upstream client — TypeScript port of Freebuff2API's upstream.go + free_session.go.
 * Speaks the Freebuff backend (codebuff.com) agent-run + free-session + chat-completions contract.
 */

/**
 * The CLI's ai-sdk UA string, byte-for-byte as captured from the real binary: the provider
 * string is composed by the ai-sdk (provider + provider-utils + runtime). Its
 * __PACKAGE_VERSION__ define never got baked into the published binary, hence "0.0.0-test".
 * Sent ONLY on chat-completions; raw API calls (session/agent-runs/me) send no UA at all.
 */
export const UPSTREAM_USER_AGENT =
  "ai-sdk/openai-compatible/0.0.0-test/codebuff ai-sdk/provider-utils/3.0.25 runtime/browser";
const FREE_SESSION_POLL_INTERVAL_MS = 5_000;

/** Per-request client session id matching the official SDK: base36, ~13 chars. */
export function generateClientSessionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(13));
  let out = "";
  for (let i = 0; i < 13; i++) out += alphabet[bytes[i]! % 36];
  return out;
}

export interface SessionState {
  status: "disabled" | "none" | "queued" | "active" | "ended" | "superseded" | string;
  instanceId: string;
  position: number;
  queueDepth: number;
  queuedAt?: string;
  expiresAt?: string;
  remainingMs?: number;
  estimatedWaitMs?: number;
  message?: string;
  /** Model the session was admitted for (echoed on POST with x-freebuff-model). */
  model?: string;
}

interface CachedSession {
  status: string;
  instanceId: string;
  /** Milliseconds since epoch; 0 when unknown. */
  expiresAtMs: number;
  position: number;
  queueDepth: number;
  /** Earliest millisecond timestamp when a queued session may be re-polled. */
  pollAtMs: number;
}

export interface UpstreamOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  httpProxy?: string;
}

export class UpstreamError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export class UpstreamClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: UpstreamOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.requestTimeoutMs;
  }

  /** POST /api/v1/agent-runs START — returns the upstream runId. */
  async startRun(authToken: string, agentId: string, signal?: AbortSignal, actingUserId?: string): Promise<string> {
    const body = await this.doJson(authToken, "/api/v1/agent-runs", {
      action: "START",
      agentId,
    }, signal, actingUserId);
    const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
    if (!runId) throw new UpstreamError(`start run response missing runId: ${JSON.stringify(body)}`, 502);
    return runId;
  }

  /** POST /api/v1/agent-runs FINISH — completes an upstream run. */
  async finishRun(authToken: string, runId: string, totalSteps: number, signal?: AbortSignal, actingUserId?: string): Promise<void> {
    await this.doJson(authToken, "/api/v1/agent-runs", {
      action: "FINISH",
      runId,
      status: "completed",
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
    }, signal, actingUserId);
  }

  /**
   * POST /api/v1/chat/completions — returns the raw Response on success (caller owns the body),
   * or parsed error details on failure.
   */
  async chatCompletions(
    authToken: string,
    body: unknown,
    signal?: AbortSignal,
    actingUserId?: string,
  ): Promise<{ response: Response } | { errorBody: string; status: number }> {
    let response: Response;
    try {
      response = await this.doRaw(authToken, "/api/v1/chat/completions", body, signal, actingUserId);
    } catch (error) {
      throw error instanceof UpstreamError ? error : new UpstreamError(String(error), 502);
    }
    if (response.status >= 200 && response.status < 300) return { response };
    const errorBody = await response.text().catch(() => "");
    return { errorBody, status: response.status };
  }

  async createOrRefreshSession(
    authToken: string,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<SessionState> {
    return this.sessionRequest(authToken, "POST", "", options?.model, options?.signal);
  }

  /** GET /api/v1/me?fields=id — the CLI's acting-user id (x-freebuff-acting-user-id header). */
  async getUserId(authToken: string, signal?: AbortSignal): Promise<string> {
    const url = joinUrl(this.baseUrl, "/api/v1/me?fields=id");
    const response = await this.requestWithTimeout(url, {
      method: "GET",
      authToken,
      accept: "application/json",
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      throw new UpstreamError(`GET /api/v1/me failed with status ${response.status}: ${body.trim()}`, response.status);
    }
    const parsed = JSON.parse(await response.text().catch(() => "{}")) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (!id) throw new UpstreamError("GET /api/v1/me response missing id", 502);
    return id;
  }

  async getSession(authToken: string, instanceId: string, signal?: AbortSignal): Promise<SessionState> {
    return this.sessionRequest(authToken, "GET", instanceId, undefined, signal);
  }

  async endSession(authToken: string, signal?: AbortSignal): Promise<void> {
    const url = joinUrl(this.baseUrl, "/api/v1/freebuff/session");
    const response = await this.requestWithTimeout(url, {
      method: "DELETE",
      authToken,
      accept: "application/json",
      signal,
    });
    if (response.status === 404) return; // session feature disabled upstream
    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      throw new UpstreamError(`free session delete failed with status ${response.status}: ${body.trim()}`, response.status);
    }
    await response.body?.cancel().catch(() => {});
  }

  private async sessionRequest(
    authToken: string,
    method: "POST" | "GET",
    instanceId: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<SessionState> {
    const url = joinUrl(this.baseUrl, "/api/v1/freebuff/session");
    const response = await this.requestWithTimeout(url, {
      method,
      authToken,
      // CLI capture: the freebuff client sends Accept: */* and an EMPTY body on POST.
      accept: "*/*",
      signal,
      ...(method === "GET" && instanceId ? { instanceIdHeader: instanceId } : {}),
      ...(method === "POST" && model ? { modelHeader: model } : {}),
    });
    if (response.status === 404) {
      return { status: "disabled", instanceId: "", position: 0, queueDepth: 0 };
    }
    const text = await response.text().catch(() => "");
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(`free session request failed with status ${response.status}: ${text.trim()}`, response.status);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new UpstreamError(`free session response is not JSON: ${text.trim().slice(0, 200)}`, 502);
    }
    const status = typeof parsed.status === "string" ? parsed.status.trim() : "";
    if (!status) throw new UpstreamError("free session response missing status", 502);
    return {
      status,
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId.trim() : "",
      position: numberField(parsed.position),
      queueDepth: numberField(parsed.queueDepth),
      ...(typeof parsed.queuedAt === "string" ? { queuedAt: parsed.queuedAt } : {}),
      ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
      ...(numberOrUndefined(parsed.remainingMs) !== undefined ? { remainingMs: numberOrUndefined(parsed.remainingMs) } : {}),
      ...(numberOrUndefined(parsed.estimatedWaitMs) !== undefined
        ? { estimatedWaitMs: numberOrUndefined(parsed.estimatedWaitMs) }
        : {}),
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
      ...(typeof parsed.model === "string" && parsed.model.trim() ? { model: parsed.model.trim() } : {}),
    };
  }

  private async doJson(
    authToken: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    actingUserId?: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.doRaw(authToken, path, body, signal, actingUserId);
    const text = await response.text().catch(() => "");
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(`${path} failed with status ${response.status}: ${text.trim()}`, response.status);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new UpstreamError(`${path} response is not JSON: ${text.trim().slice(0, 200)}`, 502);
    }
  }

  private async doRaw(
    authToken: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    actingUserId?: string,
  ): Promise<Response> {
    const url = joinUrl(this.baseUrl, path);
    return this.requestWithTimeout(url, {
      method: "POST",
      authToken,
      // CLI capture: the ai-sdk fetch sends Accept: */* on chat-completions.
      accept: "*/*",
      jsonBody: body,
      signal,
      userAgent: UPSTREAM_USER_AGENT,
      ...(actingUserId ? { actingUserIdHeader: actingUserId } : {}),
    });
  }

  private requestWithTimeout(
    url: string,
    options: {
      method: "POST" | "GET" | "DELETE";
      authToken: string;
      accept: string;
      signal?: AbortSignal;
      jsonBody?: unknown;
      instanceIdHeader?: string;
      modelHeader?: string;
      actingUserIdHeader?: string;
      /** Only chat-completions sends the ai-sdk UA; CLI raw API calls send none. */
      userAgent?: string;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${options.authToken}`,
      "Content-Type": "application/json",
      "Accept": options.accept,
    };
    if (options.userAgent) headers["User-Agent"] = options.userAgent;
    if (options.instanceIdHeader) headers["x-freebuff-instance-id"] = options.instanceIdHeader;
    if (options.modelHeader) headers["x-freebuff-model"] = options.modelHeader;
    if (options.actingUserIdHeader) headers["x-freebuff-acting-user-id"] = options.actingUserIdHeader;
    return fetchWithTimeout(url, {
      method: options.method,
      headers,
      ...(options.jsonBody !== undefined ? { body: JSON.stringify(options.jsonBody) } : {}),
      signal: options.signal,
      timeoutMs: this.timeoutMs,
    });
  }
}

export interface QueuedState {
  position: number;
  queueDepth: number;
  retryAfterMs: number;
}

export function queuedPollDelayMs(state: SessionState): number {
  if (!state.estimatedWaitMs || state.estimatedWaitMs <= 0) return FREE_SESSION_POLL_INTERVAL_MS;
  return Math.min(Math.max(state.estimatedWaitMs, 1_000), FREE_SESSION_POLL_INTERVAL_MS);
}

export function parseOptionalTimeMs(value: string | undefined): number {
  if (!value || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

export async function fetchWithTimeout(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`upstream request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
  const onOuterAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw new DOMException("upstream request aborted", "AbortError");
    }
    options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method: options.method,
      headers: options.headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onOuterAbort);
  }
}

export type { CachedSession };
