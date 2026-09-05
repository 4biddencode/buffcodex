/**
 * Buffcodex CLI.
 *
 *   buffcodex serve                      Start the Responses bridge on 127.0.0.1:17999
 *   buffcodex accounts add <token>       Add a Freebuff account auth token
 *   buffcodex accounts list              Show configured accounts
 *   buffcodex accounts remove <n>        Remove account by its list index
 *   buffcodex models                     List models exposed to Codex
 *   buffcodex doctor                     Validate config, tokens, and upstream reachability
 *   buffcodex codex install              Point Codex at this bridge (reversible)
 *   buffcodex codex remove               Restore the previous Codex routing
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  VERSION,
  getConfigPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  maskToken,
  type BuffcodexConfig,
} from "./config";
import { UpstreamClient } from "./freebuff/upstream";
import { ModelRegistry } from "./freebuff/models";
import { createRuntime, startServer } from "./server";

const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
/** Codex's picker catalog cache — stale copies shadow the provider's /v1/models, so any
 *  install/uninstall must remove it (same as codex-chatgpt-web) to force a refetch. */
const CODEX_MODELS_CACHE_PATH = join(CODEX_HOME, "models_cache.json");
const ROUTE_MARKER = "# buffcodex-managed-route";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** bcx_-prefixed, 192-bit random key for LAN exposure. */
function generateApiKey(): string {
  return `bcx_${randomBytes(24).toString("base64url")}`;
}

function ensureConfig(): BuffcodexConfig {
  if (!existsSync(getConfigPath())) {
    // Dashboard-first: an empty config is valid — the pool starts with zero accounts and
    // the user adds tokens from the dashboard at http://127.0.0.1:17999/.
    const config = defaultConfig();
    saveConfig(config);
    console.info(`created ${getConfigPath()} with no accounts — add one via:\n  buffcodex accounts add <auth-token>`);
    return config;
  }
  try {
    return loadConfig();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function cmdAccountsAdd(tokenArg: string | undefined): Promise<void> {
  const token = tokenArg?.trim();
  if (!token) fail("usage: buffcodex accounts add <auth-token>");
  const config = existsSync(getConfigPath()) ? loadConfig() : defaultConfig();
  if (config.authTokens.includes(token)) {
    console.info("that token is already configured");
    return;
  }
  console.info("validating token against the Freebuff backend…");
  const probe = new UpstreamClient({ baseUrl: config.upstreamBaseUrl, requestTimeoutMs: 20_000 });
  try {
    const session = await probe.createOrRefreshSession(token);
    console.info(`token ok (free session status: ${session.status})`);
  } catch (error) {
    fail(`token validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  config.authTokens.push(token);
  saveConfig(config);
  console.info(`added account-${config.authTokens.length} (${maskToken(token)}) — ${config.authTokens.length} account(s) total`);
}

async function cmdAccountsList(): Promise<void> {
  const config = ensureConfig();
  if (config.authTokens.length === 0) {
    console.info("no accounts configured — add one with: buffcodex accounts add <auth-token>");
    return;
  }
  console.info(`configured accounts (${config.authTokens.length}):`);
  config.authTokens.forEach((token, index) => {
    console.info(`  ${index + 1}. account-${index + 1}  ${maskToken(token)}`);
  });
}

async function cmdAccountsRemove(indexArg: string | undefined): Promise<void> {
  const index = Number.parseInt(indexArg ?? "", 10);
  if (!Number.isInteger(index) || index < 1) fail("usage: buffcodex accounts remove <index, 1-based>");
  const config = ensureConfig();
  if (index > config.authTokens.length) fail(`account-${index} does not exist (${config.authTokens.length} configured)`);
  const [removed] = config.authTokens.splice(index - 1, 1);
  if (config.authTokens.length === 0) fail("cannot remove the last account — buffcodex needs at least one token");
  saveConfig(config);
  console.info(`removed account-${index} (${maskToken(removed!)})`);
}

async function cmdModels(): Promise<void> {
  const registry = new ModelRegistry();
  await registry.start();
  const models = registry.models();
  registry.stop();
  if (models.length === 0) fail("no models available");
  console.info(`models exposed to Codex (${models.length}):`);
  for (const model of models) console.info(`  ${model}`);
}

async function cmdDoctor(): Promise<void> {
  const config = ensureConfig();
  console.info(`config: ${getConfigPath()} (version ${config.version})`);
  console.info(`upstream: ${config.upstreamBaseUrl}`);
  console.info(`accounts: ${config.authTokens.length}`);
  const probe = new UpstreamClient({ baseUrl: config.upstreamBaseUrl, requestTimeoutMs: 20_000 });
  for (const [index, token] of config.authTokens.entries()) {
    try {
      const session = await probe.createOrRefreshSession(token);
      console.info(`  account-${index + 1}: ok (session ${session.status})`);
    } catch (error) {
      console.info(`  account-${index + 1}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const registry = new ModelRegistry();
  await registry.start();
  console.info(`models: ${registry.models().length} available`);
  registry.stop();
  console.info(`codex config: ${CODEX_CONFIG_PATH}`);
  if (existsSync(CODEX_CONFIG_PATH)) {
    const text = readFileSync(CODEX_CONFIG_PATH, "utf8");
    console.info(`  bridge route: ${text.includes(ROUTE_MARKER) ? "installed" : "not installed"}`);
  } else {
    console.info("  Codex config.toml not found — run 'codex' once to create it, then 'buffcodex codex install'");
  }
}

/** Codex's default model after install — the strongest free thinking model. */
const DEFAULT_CODEX_MODEL = "z-ai/glm-5.3-flash";

/** The muxer merges the ChatGPT-app's native catalog with the Freebuff rows. The app only
 *  renders rows that carry the native schema (muxer builds those from its own template);
 *  raw 17999 rows are fine for the plain Codex CLI but invisible in the app's picker.
 *  Always pinned: the muxer upstream-forwards to the bridge, so if the bridge is down
 *  turns fail either way — a fallback route would just re-break the catalog silently. */
const MUXER_URL = "http://127.0.0.1:17850";

function routeUrl(): string {
  return `${MUXER_URL}/v1`;
}

async function cmdCodexInstall(): Promise<void> {
  const config = ensureConfig();
  const route = routeUrl();
  let text = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const backupPath = `${CODEX_CONFIG_PATH}.buffcodex-backup`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, text, { mode: 0o600 });

  // Mirror codex-chatgpt-web's managed route exactly: ONLY openai_base_url. Installing a
  // custom model_provider + provider table renames the app's provider (bottom-left shows
  // "buffcodex") and breaks the normal-chat mode switch — with just the base URL the app
  // keeps its built-in provider identity and every mode works.
  const managedLines = [
    ROUTE_MARKER,
    `openai_base_url = "${route}"`,
  ];

  const lines = text.split("\n");
  // 1) Strip the previous managed region: from the marker to the next table header.
  const markerIndex = lines.findIndex(line => line.trim() === ROUTE_MARKER);
  if (markerIndex !== -1) {
    let end = markerIndex + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    lines.splice(markerIndex, end - markerIndex);
  }
  // 1b) Remove the legacy provider table from older installs: it renamed the app's
  //     provider ("buffcodex" bottom-left) and broke the normal-chat mode switch.
  const legacyTable = lines.findIndex(line => line.trim() === "[model_providers.buffcodex]");
  if (legacyTable !== -1) {
    let end = legacyTable + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    lines.splice(legacyTable, end - legacyTable);
  }
  // 2) Ensure a valid default `model` exists. A top-level `model = "chatgpt-web/…"` is stale
  //    (that provider no longer exists) and gets replaced; a missing model gets the default;
  //    a user-chosen Freebuff model is left alone. The chatgpt-web-era effort pin goes with it.
  let insideTable = false;
  let topModel: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { insideTable = true; continue; }
    if (!insideTable && /^model\s*=/.test(trimmed)) { topModel = trimmed; break; }
  }
  const staleModel = topModel !== undefined && topModel.includes("chatgpt-web/");
  const needsDefaultModel = topModel === undefined || staleModel;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[")) { insideTable = false; continue; }
    if (!insideTable && /^(openai_base_url|model_provider)\s*=/.test(trimmed)) lines.splice(i, 1);
    if (!insideTable && needsDefaultModel && /^model\s*=/.test(trimmed)) lines.splice(i, 1);
    // A global effort pin hides the app's per-model intensity picker — never keep one,
    // ours or the user's ('codex remove' restores the backup if it was wanted).
    if (!insideTable && /^model_reasoning_effort\s*=/.test(trimmed)) lines.splice(i, 1);
  }
  if (needsDefaultModel) {
    managedLines.push(`model = "${DEFAULT_CODEX_MODEL}"`);
  }
  // 3) Top-level keys are only valid BEFORE the first table header — insert there, not at EOF.
  const firstTable = lines.findIndex(line => line.trim().startsWith("["));
  const insertAt = firstTable === -1 ? lines.length : firstTable;
  lines.splice(insertAt, 0, ...managedLines);
  writeFileSync(CODEX_CONFIG_PATH, lines.join("\n"), { mode: 0o600 });
  // A stale picker cache would keep showing the old catalog; Codex refetches from the
  // provider when the cache file is absent.
  rmSync(CODEX_MODELS_CACHE_PATH, { force: true });

  console.info(`Codex now routes through ${route}`);
  if (config.host === "0.0.0.0") {
    console.info("local Codex needs no key (loopback is trusted); remote Codex sends the bcx_ key from config.json via x-api-key or BUFFCODEX_API_KEY");
  }
  console.info(`\nprevious config saved at ${backupPath}`);
  console.info("restart Codex, then pick any 'Freebuff — …' model in the picker");
}

async function cmdCodexRemove(): Promise<void> {
  const backupPath = `${CODEX_CONFIG_PATH}.buffcodex-backup`;
  if (!existsSync(backupPath)) fail("no backup found — nothing to restore");
  const backup = readFileSync(backupPath, "utf8");
  writeFileSync(CODEX_CONFIG_PATH, backup, { mode: 0o600 });
  rmSync(backupPath);
  rmSync(CODEX_MODELS_CACHE_PATH, { force: true });
  console.info("Codex routing restored from backup");
}

async function cmdServe(): Promise<void> {
  const config = ensureConfig();
  // LAN-wide binding without a key would hand your accounts to the whole network.
  const secured = config.host === "0.0.0.0" && config.apiKeys.length === 0
    ? (() => {
        const apiKey = generateApiKey();
        saveConfig({ ...config, apiKeys: [apiKey] });
        console.info(`host is 0.0.0.0 — generated an API key (saved to config.json):\n  BUFFCODEX_API_KEY=${apiKey}`);
        return { ...config, apiKeys: [apiKey] };
      })()
    : config;
  const runtime = createRuntime(secured);
  // Live account changes (dashboard/panel) persist straight back to config.json.
  runtime.onAccountsChanged = () => {
    try {
      saveConfig({ ...runtime.config, authTokens: runtime.pool.listAccounts().map(account => account.revealToken()) });
    } catch (error) {
      console.warn(`failed to persist account change: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await runtime.registry.start();
  const server = startServer(runtime);

  const maintain = setInterval(() => {
    void runtime.pool.maintainAll();
  }, 60_000);
  maintain.unref?.();

  const shutdown = async () => {
    clearInterval(maintain);
    console.info("\nshutting down…");
    try {
      await runtime.pool.shutdown();
    } catch { /* best effort */ }
    runtime.registry.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  const dashboards = listenHosts(secured.host, secured.port);
  console.info(`serving ${secured.authTokens.length} account(s) — usage API: ${dashboards[0]} — press Ctrl+C to stop`);
  if (dashboards.length > 1) console.info(`also reachable at: ${dashboards.slice(1).join(", ")}`);
}

/** All usable dashboard URLs for the bound host (incl. LAN IPs when binding broadly). */
function listenHosts(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host}:${port}/`];
  const urls: string[] = [];
  for (const nics of Object.values(networkInterfaces())) {
    for (const nic of nics ?? []) {
      if (nic.family === "IPv4" && !nic.internal) urls.push(`http://${nic.address}:${port}/`);
    }
  }
  return urls;
}

function printHelp(): void {
  console.info(`buffcodex ${VERSION} — run Codex on every free Freebuff model

USAGE
  buffcodex <command> [args]

COMMANDS
  serve                      Start the Responses bridge (default port 17999).
                             Dashboard: http://127.0.0.1:17999/ — add accounts, watch
                             per-account usage, live notifications. With host 0.0.0.0 in
                             config, an API key is generated automatically.
  accounts add <token>       Validate and add a Freebuff account auth token
                             (the __Secure-next-auth.session-token cookie from freebuff.com).
  accounts list              List configured accounts (tokens masked).
  accounts remove <n>        Remove account n (1-based index from 'accounts list').
  models                     List the models exposed to Codex (live registry).
  doctor                     Validate config, tokens, and upstream reachability.
  codex install              Route Codex through this bridge (writes ~/.codex/config.toml,
                             backs up the original; prints the API-key env var if one is set).
  codex remove               Restore the previous Codex routing from the backup.
  help                       Show this help.
  version                    Print the version.

TYPICAL FLOW
  buffcodex accounts add <token>       # repeat for each account
  buffcodex serve                      # leave running; dashboard on :17999
  buffcodex codex install              # in another terminal; then restart Codex

LAN ACCESS
  Set "host": "0.0.0.0" in ~/.buffcodex/config.json to serve your whole network.
  An API key (bcx_…) is generated on first serve; Codex and remote clients must send it
  via the BUFFCODEX_API_KEY environment variable or an x-api-key header.

ENVIRONMENT
  BUFFCODEX_HOME             Data directory override (default ~/.buffcodex)
  BUFFCODEX_API_KEY          API key Codex sends when keys are configured`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "serve": return cmdServe();
    case "accounts":
      switch (args[0]) {
        case "add": return cmdAccountsAdd(args[1]);
        case "list": return cmdAccountsList();
        case "remove": return cmdAccountsRemove(args[1]);
        default: fail("usage: buffcodex accounts <add|list|remove> [args]");
      }
      return;
    case "models": return cmdModels();
    case "doctor": return cmdDoctor();
    case "codex":
      switch (args[0]) {
        case "install": return cmdCodexInstall();
        case "remove": return cmdCodexRemove();
        default: fail("usage: buffcodex codex <install|remove>");
      }
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      console.info(`buffcodex ${VERSION}`);
      return;
    default:
      if (command === undefined) {
        printHelp();
        return;
      }
      console.error(`unknown command: ${command}\n`);
      printHelp();
      process.exit(1);
  }
}

void main().catch(error => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
