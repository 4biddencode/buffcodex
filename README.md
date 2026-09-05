# Commandcodex

**Run Codex on every Command Code model — Claude, GPT, DeepSeek, Kimi, GLM, Qwen, MiniMax — through the official, key-authenticated Provider API.**

Commandcodex is a standalone local Responses bridge. Codex talks to it exactly like it talks
to OpenAI; every turn is routed to [commandcode.ai](https://commandcode.ai)'s Provider API
with your API key. No accounts, no pools, no fingerprinting, no ban risk — this is the
sanctioned, pay-as-you-go path.

```text
Codex ──Responses + SSE──▶ commandcodex (127.0.0.1:17999) ──▶ api.commandcode.ai/provider/v1
     ▲                              │                                (chat-completions + messages)
     └──── native picker, tools, MCP, compaction, streaming ────────┘
```

## Highlights

- **Official API.** Your key, their documented OpenAI/Anthropic-compatible endpoints.
  Claude models go to `/provider/v1/messages`; everything else to
  `/provider/v1/chat/completions` — exactly as their docs require.
- **Every model in Codex's picker.** The catalog is fetched live from
  `/provider/v1/models` (refreshed every 10 min) with per-model thinking ladders.
- **Full Codex tool harness.** Shell, apply_patch, MCP namespaces, tool_search, images,
  and remote compaction v2 all work through standard tool calling.
- **Streaming everything.** Token-level SSE to Codex, signed Anthropic thinking replayed
  so Claude's reasoning survives MultiAgent.
- **Drop-in install.** `commandcodex codex install` points Codex at the bridge (a
  reversible, backed-up edit of `~/.codex/config.toml`).

## Quick start

```bash
# 1. Get a key: commandcode.ai → Studio → API keys → Generate
commandcodex set <your-api-key>

# 2. Start the bridge (LaunchAgent on macOS keeps it alive)
commandcodex serve

# 3. Route Codex through it, then restart Codex
commandcodex codex install
```

Models appear as `commancodex/<model-id>` (e.g. `commancodex/claude-opus-5`,
`commancodex/gpt-5.6-luna`, `commancodex/deepseek/deepseek-v4-flash`).

## One-shot macOS install

```bash
tools/install-mac.sh
```

Compiles both binaries on your Mac, installs `commandcodex` + `commandcodex-mux` on PATH,
installs/refreshes the LaunchAgents, routes Codex through the muxer, and restarts the app.
Idempotent — re-run any time.

## CLI

| Command | What it does |
| --- | --- |
| `commandcodex set <api-key>` | Save + validate the Provider API key |
| `commandcodex remove-key` | Remove the stored key |
| `commandcodex serve` | Start the Responses bridge on `127.0.0.1:17999` |
| `commandcodex models` | List models exposed to Codex |
| `commandcodex doctor` | Check key, provider reachability, Codex routing |
| `commandcodex codex install` | Point Codex at the bridge (backs up config) |
| `commandcodex codex remove` | Restore the previous Codex routing |

## Configuration

`~/.commandcodex/config.json` (migrates from `~/.buffcodex` automatically):

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 17999,
  "apiKey": "your-commandcode-ai-key",
  "requestTimeoutMs": 900000,
  "apiKeys": [],
  "httpProxy": ""
}
```

Set `"host": "0.0.0.0"` for LAN access — a proxy key (`ccx_…`) is generated on first serve;
remote clients send it via `x-api-key` or `COMMANDCODEX_API_KEY`.

## LAN endpoints

- `GET /v1/models` — Codex catalog
- `POST /v1/responses` — Responses turns (SSE or JSON)
- `GET /healthz` — liveness + live-catalog state
- `POST /key/validate` — validate a key without saving it

## Disclaimer

This project is for educational purposes only, and we are not liable for any malicious
actions done by people using it.
