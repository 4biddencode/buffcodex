/**
 * Commandcodex CLI.
 *
 *   commandcodex set <api-key>     Save + validate the Command Code Provider API key
 *   commandcodex serve             Start the Responses bridge
 *   commandcodex models            List models exposed to Codex
 *   commandcodex doctor            Validate key, upstream reachability, Codex routing
 *   commandcodex codex install     Point Codex at this bridge (reversible)
 *   commandcodex codex remove      Restore the previous Codex routing
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
  type CommandCodexConfig,
} from "./config";
import { CommancodexClient } from "./commancodex/client";
import { createRuntime, startServer, refreshProviderModels } from "./server";

const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
const CODEX_CONFIG_PATH = join(CODEX_HOME, "config.toml");
/** Codex's picker catalog cache — stale copies shadow the provider's /v1/models, so any
 *  install/uninstall must remove it to force a refetch (same as codex-chatgpt-web). */
const CODEX_MODELS_CACHE_PATH = join(CODEX_HOME, "models_cache.json");
const ROUTE_MARKER = "# commandcodex-managed-route";
const LEGACY_ROUTE_MARKER = "# buffcodex-managed-route";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** ccx_-prefixed, 192-bit random key for LAN exposure. */
function generateApiKey(): string {
  return `ccx_${randomBytes(24).toString("base64url")}`;
}

function ensureConfig(requireKey = false): CommandCodexConfig {
  if (!existsSync(getConfigPath())) {
    const config = defaultConfig();
    saveConfig(config);
    console.info(`created ${getConfigPath()} — add your Provider API key with:\n  commandcodex set <api-key>`);
    if (requireKey) fail("no Provider API key configured yet");
    return config;
  }
  try {
    return loadConfig(requireKey);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function clientFor(config: CommandCodexConfig, apiKey = config.apiKey): CommancodexClient {
  return new CommancodexClient({
    apiKey,
    ...(config.providerBaseUrl ? { baseUrl: config.providerBaseUrl } : {}),
  });
}

async function cmdSet(keyArg: string | undefined): Promise<void> {
  const apiKey = keyArg?.trim();
  if (!apiKey) fail("usage: commandcodex set <api-key>  (create one at commandcode.ai → Studio → API keys)");
  const config = existsSync(getConfigPath()) ? ensureConfig() : defaultConfig();
  config.apiKey = apiKey;
  saveConfig(config);
  // Validate the key immediately so a typo never silently serves 401s.
  try {
    const models = await clientFor(config, apiKey).listModels();
    console.info(`Provider API key saved (${maskToken(apiKey)}) — ${models.length} models reachable`);
    console.info("run 'commandcodex serve' (or restart the LaunchAgent) to pick it up");
  } catch (error) {
    console.warn(`key saved, but validation failed: ${error instanceof Error ? error.message : String(error)}`);
    console.warn(`double-check the key in ${getConfigPath()}`);
  }
}

async function cmdRemoveKey(): Promise<void> {
  const config = ensureConfig();
  if (!config.apiKey) {
    console.info("no Provider API key configured");
    return;
  }
  config.apiKey = "";
  saveConfig(config);
  console.info("Provider API key removed");
}

async function cmdModels(): Promise<void> {
  const config = ensureConfig();
  if (!config.apiKey) fail(`no Provider API key configured — run 'commandcodex set <api-key>'`);
  const runtime = createRuntime(config);
  if (runtime.providerRows.length === 0) fail("no models available — is the key valid? run 'commandcodex doctor'");
  console.info(`models exposed to Codex (${runtime.providerRows.length}):`);
  for (const row of runtime.providerRows) console.info(`  commancodex/${row.id}`);
}

async function cmdTransport(transportArg: string | undefined): Promise<void> {
  const transport = transportArg?.trim();
  if (transport !== "api" && transport !== "cli") {
    fail("usage: commandcodex transport <api|cli>\n  api = Provider REST endpoints (needs a plan with API access)\n  cli = drive the official command-code CLI headless (works on every plan)");
  }
  const config = ensureConfig();
  config.transport = transport;
  saveConfig(config);
  console.info(`transport set to ${transport}`);
  if (transport === "cli") {
    console.info("the official CLI (cmd) must be installed: npm i -g command-code (or bun add -g command-code)");
    console.info("auth uses the same key via the COMMAND_CODE_API_KEY env var automatically");
  }
}

async function cmdDoctor(): Promise<void> {
  const config = ensureConfig();
  console.info(`config: ${getConfigPath()} (version ${config.version})`);
  console.info(`provider: ${config.providerBaseUrl ?? "https://api.commandcode.ai"}`);
  console.info(`transport: ${config.transport ?? "api"}`);
  console.info(`key: ${config.apiKey ? maskToken(config.apiKey) : "MISSING"}`);
  if (config.apiKey) {
  try {
    const models = await clientFor(config).listModels();
    console.info(`  provider: ok (${models.length} models)`);
  } catch (error) {
    console.info(`  provider: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((config.transport ?? "api") === "cli") {
    const { execFile } = await import("node:child_process");
    const cliPath = config.cliPath ?? "cmd";
    await new Promise<void>(resolve => {
      execFile(cliPath, ["--version"], { env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:/opt/homebrew/opt/node/bin:${process.env.PATH ?? ""}` } }, error => {
        console.info(`  cli (${cliPath}): ${error ? "NOT FOUND — install with 'bun add -g command-code'" : "ok"}`);
        resolve();
      });
    });
  }
}
  console.info(`codex config: ${CODEX_CONFIG_PATH}`);
  if (existsSync(CODEX_CONFIG_PATH)) {
    const text = readFileSync(CODEX_CONFIG_PATH, "utf8");
    const managed = text.includes(ROUTE_MARKER) || text.includes(LEGACY_ROUTE_MARKER);
    console.info(`  bridge route: ${managed ? "installed" : "not installed"}`);
  } else {
    console.info("  Codex config.toml not found — run 'codex' once, then 'commandcodex codex install'");
  }
}

/** Codex's default model after install — the strongest open thinking model on the API. */
const DEFAULT_CODEX_MODEL = "commancodex/gpt-5.3-codex";

/** The muxer merges the ChatGPT-app's native catalog with the commancodex rows. The app
 *  only renders rows that carry the native schema (muxer builds those from its own
 *  template). Always pinned: the muxer upstream-forwards to this bridge, so a fallback
 *  route would just re-break the catalog silently. */
const MUXER_URL = "http://127.0.0.1:17850";

function routeUrl(): string {
  return `${MUXER_URL}/v1`;
}

async function cmdCodexInstall(): Promise<void> {
  ensureConfig();
  const route = routeUrl();
  let text = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  const backupPath = `${CODEX_CONFIG_PATH}.commandcodex-backup`;
  if (!existsSync(backupPath)) writeFileSync(backupPath, text, { mode: 0o600 });

  // Mirror codex-chatgpt-web's managed route exactly: ONLY openai_base_url. Installing a
  // custom model_provider + provider table renames the app's provider (bottom-left shows
  // the custom name) and breaks the normal-chat mode switch — with just the base URL the
  // app keeps its built-in provider identity and every mode works.
  const managedLines = [
    ROUTE_MARKER,
    `openai_base_url = "${route}"`,
  ];

  const lines = text.split("\n");
  // 1) Strip the previous managed region: from the marker to the next table header.
  const markerIndex = lines.findIndex(line => {
    const trimmed = line.trim();
    return trimmed === ROUTE_MARKER || trimmed === LEGACY_ROUTE_MARKER;
  });
  if (markerIndex !== -1) {
    let end = markerIndex + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    lines.splice(markerIndex, end - markerIndex);
  }
  // 1b) Remove the legacy provider table from older installs (buffcodex era).
  const legacyTable = lines.findIndex(line => /^\[model_providers\.(buffcodex|commandcodex)\]/.test(line.trim()));
  if (legacyTable !== -1) {
    let end = legacyTable + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    lines.splice(legacyTable, end - legacyTable);
  }

  // 2) Ensure a valid default `model` exists. A stale chatgpt-web/ or removed-provider
  //    model is replaced; a missing model gets the default; a user-chosen commancodex
  //    model is left alone. Any global effort pin goes with it (hides the picker).
  let insideTable = false;
  let topModel: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) { insideTable = true; continue; }
    if (!insideTable && /^model\s*=/.test(trimmed)) { topModel = trimmed; break; }
  }
  const staleModel = topModel !== undefined
    && (topModel.includes("chatgpt-web/") || topModel.includes("buffcodex/") || topModel.includes("commandcode/"));
  const needsDefaultModel = topModel === undefined || staleModel;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("[")) { insideTable = false; continue; }
    if (!insideTable && /^(openai_base_url|model_provider)\s*=/.test(trimmed)) lines.splice(i, 1);
    if (!insideTable && needsDefaultModel && /^model\s*=/.test(trimmed)) lines.splice(i, 1);
    // A global effort pin hides the app's per-model intensity picker — never keep one.
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
  if (existsSync(getConfigPath())) {
    const parsed = loadConfig().host;
    if (parsed === "0.0.0.0") {
      console.info("local Codex needs no key (loopback is trusted); remote Codex sends the ccx_ key from config.json via x-api-key or COMMANDCODEX_API_KEY");
    }
  }
  console.info(`\nprevious config saved at ${backupPath}`);
  console.info("restart Codex, then pick any 'Commancodex — …' model in the picker");
}

async function cmdCodexRemove(): Promise<void> {
  const backupPath = `${CODEX_CONFIG_PATH}.commandcodex-backup`;
  const legacyBackupPath = `${CODEX_CONFIG_PATH}.buffcodex-backup`;
  const restoreFrom = existsSync(backupPath) ? backupPath : existsSync(legacyBackupPath) ? legacyBackupPath : undefined;
  if (!restoreFrom) fail("no backup found — nothing to restore");
  const backup = readFileSync(restoreFrom, "utf8");
  writeFileSync(CODEX_CONFIG_PATH, backup, { mode: 0o600 });
  rmSync(restoreFrom);
  rmSync(CODEX_MODELS_CACHE_PATH, { force: true });
  console.info("Codex routing restored from backup");
}

async function cmdServe(): Promise<void> {
  const config = ensureConfig(true);
  // LAN-wide binding without a key would hand your Provider API key to the whole network.
  const secured = config.host === "0.0.0.0" && config.apiKeys.length === 0
    ? (() => {
        const apiKey = generateApiKey();
        saveConfig({ ...config, apiKeys: [apiKey] });
        console.info(`host is 0.0.0.0 — generated a proxy API key (saved to config.json):\n  COMMANDCODEX_API_KEY=${apiKey}`);
        return { ...config, apiKeys: [apiKey] };
      })()
    : config;
  const runtime = createRuntime(secured);
  const server = startServer(runtime);

  const count = await refreshProviderModels(runtime);
  console.info(`provider catalog: ${count} model(s) via the official Command Code Provider API`);

  const ccRefresh = setInterval(() => void refreshProviderModels(runtime), 10 * 60_000);
  ccRefresh.unref?.();

  const shutdown = async () => {
    clearInterval(ccRefresh);
    console.info("\nshutting down…");
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  const urls = listenHosts(secured.host, secured.port);
  console.info(`serving on ${urls[0]} — press Ctrl+C to stop`);
  if (urls.length > 1) console.info(`also reachable at: ${urls.slice(1).join(", ")}`);
}

/** All usable bridge URLs for the bound host (incl. LAN IPs when binding broadly). */
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
  console.info(`commandcodex ${VERSION} — run Codex on every Command Code model (official Provider API)

USAGE
  commandcodex <command> [args]

COMMANDS
  set <api-key>              Save + validate the Command Code Provider API key
                             (commandcode.ai → Studio → API keys).
  remove-key                 Remove the stored Provider API key.
  transport <api|cli>        Upstream transport: "api" = Provider REST (needs a plan
                             with API access); "cli" = drive the official command-code
                             CLI headless — works on EVERY plan, including Go.
  serve                      Start the Responses bridge (default port 17999).
  models                     List the models exposed to Codex (live provider catalog).
  doctor                     Validate key, provider reachability, and Codex routing.
  codex install              Route Codex through this bridge (writes ~/.codex/config.toml,
                             backs up the original).
  codex remove               Restore the previous Codex routing from the backup.
  help                       Show this help.
  version                    Print the version.

TYPICAL FLOW
  commandcodex set <api-key>           # commandcode.ai → Studio → API keys
  commandcodex serve                   # leave running
  commandcodex codex install           # in another terminal; then restart Codex

LAN ACCESS
  Set "host": "0.0.0.0" in ~/.commandcodex/config.json to serve your whole network.
  A proxy API key (ccx_…) is generated on first serve; remote clients must send it
  via the COMMANDCODEX_API_KEY environment variable or an x-api-key header.

ENVIRONMENT
  COMMANDCODEX_HOME          Data directory override (default ~/.commandcodex)
  COMMANDCODEX_API_KEY       Proxy API key remote Codex sends when keys are configured`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "serve": return cmdServe();
    case "set": return cmdSet(args[0]);
    case "remove-key": return cmdRemoveKey();
    case "transport": return cmdTransport(args[0]);
    case "models": return cmdModels();
    case "doctor": return cmdDoctor();
    case "codex":
      switch (args[0]) {
        case "install": return cmdCodexInstall();
        case "remove": return cmdCodexRemove();
        default: fail("usage: commandcodex codex <install|remove>");
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
      console.info(`commandcodex ${VERSION}`);
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
