import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VERSION = "1.0.0";

/** Commandcodex data dir (~/.commandcodex; migrates from the legacy ~/.buffcodex). */
export function getConfigDir(): string {
  const configured = process.env.COMMANDCODEX_HOME?.trim();
  if (configured) return resolve(expandUserPath(configured));
  const legacyDir = join(homedir(), ".buffcodex");
  const dir = join(homedir(), ".commandcodex");
  // One-time migration: keep tokens/keys/config from the buffcodex era.
  if (!existsSync(dir) && existsSync(legacyDir)) {
    try {
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(legacyDir, dir);
    } catch {
      return resolve(legacyDir);
    }
  }
  return resolve(dir);
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Official Provider API base (commandcode.ai docs: /provider/v1/...). */
export const DEFAULT_PROVIDER_BASE_URL = "https://api.commandcode.ai";

export interface CommandCodexConfig {
  version: 1;
  /** Bind address. Loopback, or 0.0.0.0 for LAN-wide access. */
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  /** Provider API bearer key (commandcode.ai → Studio → API keys). */
  apiKey: string;
  /** Provider API base override (default https://api.commandcode.ai). */
  providerBaseUrl?: string;
  /**
   * Upstream transport. "api" = the Provider REST endpoints (needs a plan with API
   * access). "cli" = drive the official command-code CLI headless (`cmd -p`), which
   * works on every plan and is their documented automation surface. Default: "api".
   */
  transport?: "api" | "cli";
  /** CLI binary override for transport=cli (default "cmd" resolved on PATH). */
  cliPath?: string;
  /** Upstream HTTP timeout for a full streaming turn. */
  requestTimeoutMs: number;
  /** Optional client API keys for proxy auth (empty = open loopback access). */
  apiKeys: string[];
  /** Optional HTTP proxy for outbound requests. */
  httpProxy: string;
  /** Optional context window override advertised to Codex for every model. */
  contextWindow?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PORT = 17999;

export function defaultConfig(): CommandCodexConfig {
  return {
    version: 1,
    host: "127.0.0.1",
    port: DEFAULT_PORT,
    apiKey: "",
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
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}

/**
 * Parse a config object. `requireKey` (serve) demands a configured apiKey; setup
 * commands parse without it so the key can be added first.
 */
export function parseConfig(value: unknown, source: string, requireKey = false): CommandCodexConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid configuration object in ${source}`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error(`Unsupported configuration version in ${source}`);
  if (raw.host !== "127.0.0.1" && raw.host !== "0.0.0.0") {
    throw new Error("host must be 127.0.0.1 (local only) or 0.0.0.0 (LAN-wide)");
  }
  if (!Number.isInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65_535) {
    throw new Error(`Invalid port in ${source}`);
  }
  if (raw.apiKeys !== undefined && !Array.isArray(raw.apiKeys)) throw new Error(`Invalid apiKeys in ${source}`);
  if (raw.contextWindow !== undefined
    && (!Number.isSafeInteger(raw.contextWindow) || (raw.contextWindow as number) <= 0)) {
    throw new Error(`Invalid contextWindow in ${source}`);
  }

  // Accept the new flat key plus the pre-rename spellings so existing setups migrate.
  const commancodexBlock = raw.commancodex && typeof raw.commancodex === "object" ? raw.commancodex as Record<string, unknown> : {};
  const apiKey = [
    raw.apiKey,
    commancodexBlock.apiKey,
    (raw.commandCode as Record<string, unknown> | undefined)?.apiKey,
    (raw.commancodex as Record<string, unknown> | undefined)?.apiKey,
  ]
    .map(entry => (typeof entry === "string" ? entry.trim() : ""))
    .find(entry => entry.length > 0) ?? "";
  const providerBaseCandidate = [
    raw.providerBaseUrl,
    commancodexBlock.baseUrl,
    (raw.commandCode as Record<string, unknown> | undefined)?.baseUrl,
    (raw.commancodex as Record<string, unknown> | undefined)?.baseUrl,
  ]
    .map(entry => (typeof entry === "string" ? entry.trim() : ""))
    .find(entry => entry.length > 0);
  const providerBaseUrl = providerBaseCandidate ? normalizeBaseUrl(providerBaseCandidate) : DEFAULT_PROVIDER_BASE_URL;
  if (!/^https?:\/\//.test(providerBaseUrl)) throw new Error(`Invalid providerBaseUrl in ${source}`);
  if (requireKey && !apiKey) {
    throw new Error(`No Provider API key configured in ${source}. Run 'commandcodex set <api-key>' first.`);
  }

  return {
    version: 1,
    host: raw.host as CommandCodexConfig["host"],
    port: raw.port as number,
    apiKey,
    ...(providerBaseCandidate ? { providerBaseUrl } : {}),
    ...(raw.transport === "cli" || raw.transport === "api" ? { transport: raw.transport } : {}),
    ...(typeof raw.cliPath === "string" && raw.cliPath.trim() ? { cliPath: raw.cliPath.trim() } : {}),
    requestTimeoutMs: Number.isFinite(raw.requestTimeoutMs) && (raw.requestTimeoutMs as number) > 0
      ? raw.requestTimeoutMs as number
      : DEFAULT_REQUEST_TIMEOUT_MS,
    apiKeys: Array.isArray(raw.apiKeys)
      ? [...new Set((raw.apiKeys as unknown[]).map(key => String(key).trim()).filter(Boolean))]
      : [],
    httpProxy: typeof raw.httpProxy === "string" ? raw.httpProxy.trim() : "",
    ...(Number.isSafeInteger(raw.contextWindow) ? { contextWindow: raw.contextWindow as number } : {}),
  };
}

export function loadConfig(requireKey = false): CommandCodexConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    throw new Error(`Configuration is missing: ${path}. Run 'commandcodex set <api-key>' first.`);
  }
  return parseConfig(JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))), path, requireKey);
}

export function saveConfig(config: CommandCodexConfig): void {
  const path = getConfigPath();
  atomicWriteFile(path, JSON.stringify(config, null, 2) + "\n");
}

/** Atomic replace: temp file in the same dir, fsync-free rename with Windows retry. */
export function atomicWriteFile(path: string, data: string): void {
  const { openSync, closeSync, writeSync, renameSync, rmSync, chmodSync } =
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

/** Mask a key for display: keep a short prefix and suffix. */
export function maskToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
