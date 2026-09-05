/**
 * Commancodex Provider API client — https://commancodex.ai/docs/provider
 *
 * This is the OFFICIAL, key-authenticated endpoint (no account pools, no
 * CLI impersonation): OpenAI Chat Completions at /provider/v1/chat/completions,
 * Anthropic Messages at /provider/v1/messages. Claude models MUST go to /messages
 * ("Send a Claude model to /chat/completions and you get a 400 pointing you to
 * /messages, and the reverse" — Provider API FAQ).
 */
import { DEFAULT_PROVIDER_BASE_URL } from "../config";

const CHAT_PATH = "/provider/v1/chat/completions";
const MESSAGES_PATH = "/provider/v1/messages";
const MODELS_PATH = "/provider/v1/models";

export class CommancodexError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly type?: string;

  constructor(message: string, status: number, code?: string, type?: string) {
    super(message);
    this.name = "CommancodexError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

/** Claude models speak Anthropic Messages; everything else speaks Chat Completions. */
export function isAnthropicModel(upstreamId: string): boolean {
  return /^claude[-_/]/i.test(upstreamId) || /^anthropic\//i.test(upstreamId);
}

export interface CommancodexClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Full streaming-turn timeout (defaults to 15 min). */
  requestTimeoutMs?: number;
  httpProxy?: string;
}

export interface ProviderModelRow {
  id: string;
  name?: string;
  context_length?: number;
  owned_by?: string;
}

export class CommancodexClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly httpProxy: string;

  constructor(options: CommancodexClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_PROVIDER_BASE_URL).replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
    this.httpProxy = options.httpProxy ?? "";
  }

  private authHeaders(anthropicShape: boolean): Record<string, string> {
    // Docs: Authorization: Bearer works on ANY route; x-api-key is for Anthropic SDKs.
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...(anthropicShape ? { "anthropic-version": "2023-06-01" } : {}),
    };
  }

  /** GET /provider/v1/models — live catalog with names and context lengths. */
  async listModels(): Promise<ProviderModelRow[]> {
    const response = await this.rawFetch(`${this.baseUrl}${MODELS_PATH}`, {
      method: "GET",
      headers: this.authHeaders(false),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw await this.errorFrom(response, "models list");
    const parsed = await response.json().catch(() => null) as { data?: ProviderModelRow[] } | null;
    return Array.isArray(parsed?.data) ? parsed!.data! : [];
  }

  /** POST /provider/v1/chat/completions (OpenAI shape, stream: true). */
  async chatCompletion(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.postStream(CHAT_PATH, body, false, signal);
  }

  /** POST /provider/v1/messages (Anthropic shape, stream: true). */
  async anthropicMessages(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.postStream(MESSAGES_PATH, body, true, signal);
  }

  private async postStream(
    path: string,
    body: Record<string, unknown>,
    anthropicShape: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.rawFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders(anthropicShape),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    if (!response.ok) {
      const error = await this.errorFrom(response, path);
      // Always release the body of a failed JSON-error response.
      try { await response.arrayBuffer(); } catch { /* ignore */ }
      throw error;
    }
    return response;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.httpProxy) {
      // Follow the bridge's optional outbound proxy convention (same as UpstreamClient).
      const { ProxyAgent, fetch: proxyFetch } = await import("undici");
      const agent = new ProxyAgent(this.httpProxy);
      return proxyFetch(url, { ...init, dispatcher: agent } as never) as unknown as Response;
    }
    return fetch(url, init);
  }

  private async errorFrom(response: Response, context: string): Promise<CommancodexError> {
    let bodyText = "";
    try { bodyText = await response.text(); } catch { /* ignore */ }
    let message = `${context} failed with status ${response.status}`;
    let code: string | undefined;
    let type: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: unknown; type?: unknown; code?: unknown } | string;
        message?: unknown;
      };
      const err = parsed.error;
      if (typeof err === "object" && err !== null) {
        if (typeof err.message === "string") message = err.message;
        if (typeof err.type === "string") type = err.type;
        if (typeof err.code === "string") code = err.code;
      } else if (typeof err === "string") {
        message = err;
      } else if (typeof parsed.message === "string") {
        message = parsed.message;
      }
    } catch {
      if (bodyText) message = bodyText.slice(0, 500);
    }
    return new CommancodexError(message, response.status, code, type);
  }
}
