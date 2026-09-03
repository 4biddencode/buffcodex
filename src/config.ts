import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VERSION = "0.1.0";

/** Buffcodex data dir (~/.buffcodex, overridable via BUFFCODEX_HOME). */
export function getConfigDir(): string {
  const configured = process.env.BUFFCODEX_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".buffcodex")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export interface BuffcodexConfig {
  version: 1;
  /** Codex-facing Responses proxy bind address. Loopback, or 0.0.0.0 for LAN-wide access. */
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  /** Freebuff backend base URL. */
  upstreamBaseUrl: string;
  /** Freebuff auth tokens, one per account. Order defines the pool labels. */
  authTokens: string[];
  /** Rotate an account's agent run after this long (keeps upstream runs fresh). */
  rotationIntervalMs: number;
  /** Upstream HTTP timeout for a full streaming turn. */
  requestTimeoutMs: number;
  /** Optional client API keys for proxy auth (empty = open loopback access). */
  apiKeys: string[];
  /** Optional HTTP proxy for outbound requests. */
  httpProxy: string;
  /** Optional context window override advertised to Codex for every model. */
  contextWindow?: number;
}

const DEFAULT_ROTATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export function defaultConfig(): BuffcodexConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: 17999,
    upstreamBaseUrl: "https://www.codebuff.com",
    authTokens: [],
    rotationIntervalMs: DEFAULT_ROTATION_INTERVAL_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    apiKeys: [],
    httpProxy: "",
  };
}

function stripUtf8Bom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.host === "codebuff.com") parsed.host = "www.codebuff.com";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

export function parseConfig(value: unknown, source: string): BuffcodexConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid configuration object in ${source}`);
  }
  const raw = value as Partial<BuffcodexConfig>;
  if (raw.version !== 1) throw new Error(`Unsupported configuration version in ${source}`);
  if (raw.host !== "127.0.0.1" && raw.host !== "0.0.0.0") {
    throw new Error("host must be 127.0.0.1 (local only) or 0.0.0.0 (LAN-wide)");
  }
  if (!Number.isInteger(raw.port) || raw.port! < 1 || raw.port! > 65_535) {
    throw new Error(`Invalid port in ${source}`);
  }
  if (!Array.isArray(raw.authTokens)) throw new Error(`Missing authTokens in ${source}`);
  // An empty roster is valid (dashboard-first: accounts get added live); requests fail
  // gracefully with "no auth tokens configured" until then.
  const authTokens = [...new Set(raw.authTokens.map(token => String(token).trim()).filter(Boolean))];
  const upstreamBaseUrl = normalizeBaseUrl(typeof raw.upstreamBaseUrl === "string" ? raw.upstreamBaseUrl : "");
  if (!/^https?:\/\//.test(upstreamBaseUrl)) throw new Error(`Invalid upstreamBaseUrl in ${source}`);
  if (raw.apiKeys !== undefined && !Array.isArray(raw.apiKeys)) throw new Error(`Invalid apiKeys in ${source}`);
  if (raw.contextWindow !== undefined
    && (!Number.isSafeInteger(raw.contextWindow) || raw.contextWindow! <= 0)) {
    throw new Error(`Invalid contextWindow in ${source}`);
  }
  return {
    version: 1,
    host: raw.host,
    port: raw.port!,
    upstreamBaseUrl,
    authTokens,
    rotationIntervalMs: Number.isFinite(raw.rotationIntervalMs) && raw.rotationIntervalMs! > 0
      ? raw.rotationIntervalMs!
      : DEFAULT_ROTATION_INTERVAL_MS,
    requestTimeoutMs: Number.isFinite(raw.requestTimeoutMs) && raw.requestTimeoutMs! > 0
      ? raw.requestTimeoutMs!
      : DEFAULT_REQUEST_TIMEOUT_MS,
    apiKeys: Array.isArray(raw.apiKeys)
      ? [...new Set(raw.apiKeys.map(key => String(key).trim()).filter(Boolean))]
      : [],
    httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy.trim() : "",
    ...(Number.isSafeInteger(raw.contextWindow) ? { contextWindow: raw.contextWindow } : {}),
  };
}

export function loadConfig(): BuffcodexConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    throw new Error(`Configuration is missing: ${path}. Run 'buffcodex accounts add <token>' first.`);
  }
  return parseConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), path);
}

export function saveConfig(config: BuffcodexConfig): void {
  const path = getConfigPath();
  atomicWriteFile(path, JSON.stringify(config, null, 2) + "\n");
}

/** Atomic replace: temp file in the same dir, fsync-free rename with Windows retry. */
export function atomicWriteFile(path: string, data: string): void {
  const { mkdirSync, openSync, closeSync, writeSync, renameSync, rmSync, chmodSync } =
    require("node:fs") as typeof import("node:fs");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, data);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs */ }
}

/** Mask a token for display: keep a short prefix and suffix. */
export function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
