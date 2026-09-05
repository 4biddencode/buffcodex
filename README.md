# Buffcodex

**Run Codex on every free Freebuff model — with multiple accounts and concurrent chats.**

Buffcodex is a standalone local Responses bridge. Codex talks to it exactly like it talks to
OpenAI; Buffcodex routes every turn through the Freebuff backend's free tier using a pool of
your accounts. No browser, no ChatGPT, no tunnel.

```text
Codex ──Responses + SSE──▶ buffcodex (127.0.0.1:17999) ──chat-completions──▶ Freebuff free tier
     ▲                              │                                          │
     └──── native picker, tools, MCP, compaction, streaming ─────────────────┘
```

## Highlights

- **Every free model in Codex's picker.** The catalog is fetched live from Codebuff's
  `FREE_MODE_AGENT_MODELS` source and refreshed every 6h — GLM, Luna, DeepSeek, MiniMax, MiMo,
  Kimi, Solar, and friends appear as native Codex rows.
- **Multiple accounts, one pool.** Add as many Freebuff auth tokens as you like. Requests
  round-robin across accounts, so parallel Codex chats actually run in parallel and no single
  account's free quota burns out first. Waiting-room states, cooldowns, and run lifecycle are
  handled per account automatically.
- **Full Codex tool harness.** Shell, apply_patch, MCP namespaces, tool_search, images, and
  remote compaction v2 all work through standard chat-completions tool calling.
- **Drop-in install.** `buffcodex codex install` points Codex at the bridge (a reversible,
  backed-up edit of `~/.codex/config.toml`).

## Quick start

Requires [Bun](https://bun.sh) 1.4+.

### One-shot install (macOS)

From a checkout of this repo:

```bash
tools/install-mac.sh
```

That builds both binaries (bridge + catalog muxer), puts them on your PATH, installs + starts
the background services (LaunchAgents), routes Codex through the muxer, and restarts the
Codex/ChatGPT app with the merged model catalog. Re-run it any time after updating — accounts
in `~/.buffcodex/config.json` are never touched.

### Manual install
```bash
cd buffcodex
bun install

# 1. Add one or more Freebuff accounts (tokens are validated before saving)
bun run src/cli.ts accounts add <auth-token-1>
bun run src/cli.ts accounts add <auth-token-2>   # optional — more accounts, more headroom

# 2. Point Codex at the bridge
bun run src/cli.ts codex install

# 3. Serve
bun run src/cli.ts serve
```

Restart Codex and pick any **Freebuff — …** model in the picker.

### Where do I get an auth token?

- Web: log in at `freebuff.llm.pm` and copy the displayed token, or
- CLI: `npm i -g freebuff`, run `freebuff`, log in, and copy `authToken` from
  `~/.config/manicode/credentials.json`.

Log in with several Freebuff accounts and add every token — that is the whole point of the pool.

## CLI

```
buffcodex serve                    start the Responses bridge (usage API at /usage)
buffcodex accounts add <token>     validate + save a Freebuff auth token
buffcodex accounts list            list configured accounts
buffcodex accounts remove <n>      remove account n (1-based)
buffcodex models                   list the models exposed to Codex
buffcodex doctor                   validate config, tokens, upstream reachability
buffcodex codex install            route Codex through the bridge (backs up config.toml)
buffcodex codex remove             restore the previous Codex routing
```

Accounts can also be added/removed **live** via `POST /accounts` (the bridge persists changes
straight back to `config.json`). Banned or invalid (401) accounts are detected automatically
and removed from the pool + config on the spot.

## Usage API

Open `http://127.0.0.1:17999/usage` while serving:

- **Per-account usage + session/run snapshots** (`GET /usage`).
- **Add account** — `POST /accounts` validates a token against the Freebuff backend before it
  joins the pool.

Programmatic access:

```
GET /usage      per-account usage + session/run snapshots
GET /healthz    liveness + the same snapshots
POST /accounts  {"action":"add","token":"…"} | {"action":"remove","name":"account-2"}
```

## Configuration

`~/.buffcodex/config.json` (override the directory with `BUFFCODEX_HOME`):

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 17999,
  "upstreamBaseUrl": "https://www.codebuff.com",
  "authTokens": ["token-a", "token-b"],
  "rotationIntervalMs": 21600000,
  "requestTimeoutMs": 900000,
  "apiKeys": [],
  "httpProxy": ""
}
```

| Key | Meaning |
| --- | --- |
| `authTokens` | Freebuff auth tokens — one per account, the multi-account pool |
| `port` | Codex-facing bridge port (Codex route becomes `http://127.0.0.1:<port>/v1`) |
| `apiKeys` | Optional client keys; when set, requests must send `Authorization: Bearer <key>` |
| `contextWindow` | Optional context-window override advertised to Codex for every model |
| `httpProxy` | Optional outbound proxy (note: Bun's fetch ignores it; set `HTTP_PROXY` env instead) |

Environment overrides when adding accounts non-interactively: none — tokens live only in
`config.json` and inside the running pool.

## How routing works

1. Codex sends a normal Responses request (`/v1/responses`, SSE) to the bridge.
2. The bridge parses it into its canonical form (parser shared with codex-chatgpt-web),
   resolves the model → free agent id via the live registry, and acquires an account from the
   pool (round-robin, skipping cooling-down/waiting-room accounts).
3. The account's upstream run is ensured (START/FINISH lifecycle, rotated every 6h), the free
   session is ensured (created, polled through the waiting room), and the turn is forwarded as
   chat-completions with `codebuff_metadata` (`cost_mode: free`).
4. The upstream SSE stream is converted on the fly into Responses events: reasoning deltas,
   text deltas, streaming tool calls, usage.
5. Invalid runs/sessions are retried once on a fresh run/account; exhausted accounts cool down
   for 30 minutes; usage lands in the per-account ledger.

### Session expiry: server-sided, renewal: client-sided

The 1-hour free-session lifetime is owned by the Freebuff backend (`expiresAt` in every session
response) — the bridge never decides when a session dies. What the bridge does own is **instant
renewal**: a per-account timer arms at `expiresAt − 5s` the moment a session turns active, fires
refreshes proactively, and re-arms forever (failures retry on a 5s backoff). Free sessions stay
hot so no request ever lands on a lapsed session. Premium/limited sessions are deliberately NOT
auto-renewed — admission is metered server-side — so instead the bridge emits a notification.

### Thinking models & reasoning effort

Codex's `/model` settings menu lets you change reasoning effort per model — the bridge
advertises each model's real ladder, and the outgoing request carries exactly what you pick:

| Model | Thinking | Efforts |
| --- | --- | --- |
| `z-ai/glm-5.3-flash` | yes | low, high, **max** (default) |
| `deepseek/deepseek-v4-*` | yes | low, medium, high, xhigh, **max** (default) |
| `mimo/mimo-v2.5`, `openai/gpt-5.6-luna*`, `upstage/solar-pro4` | no | effort stripped from requests |
| other GLM/Kimi/Qwen/Minimax/Gemini | yes (family default) | low, medium, high |

Defaults follow the web UI: `reasoningEffort: "max"` for thinking models (it carries no extra
quota on the free path), and no `reasoning_effort` field at all for models that cannot think —
sending one would just waste tokens. Out-of-ladder efforts clamp to the nearest supported
value, ties rounding up.

### Model tiers & notifications

The registry also parses the upstream tier lists each refresh:

| Tier | Meaning | Behavior |
| --- | --- | --- |
| `free` | standard free pool | auto-renewing sessions |
| `premium` | daily premium pool (limit 4/day per account): `openai/gpt-5.6-luna`, `upstage/solar-pro4` | notification on every use, no auto-renew |
| `limited` | shared global pool: `anthropic/claude-fable-5` | notification on every use |
| `paused` | recognized upstream but served to nobody | filtered out of `/v1/models` |

Notifications (renewals, waiting-room queue moves, cooldowns, premium/limited model use,
renewal failures) flow through a bounded ring buffer, exposed at `GET /notifications`,streamed incrementally via `GET /usage?since=`.

## Tests

```bash
bun run typecheck
bun test
```

41 tests cover request/response conversion, per-model thinking ladders and effort clamping,
SSE streaming, account rotation, waiting-room handling, instant session renewal, the
notification hub, tier parsing, the registry parser (both upstream formats), and end-to-end
server turns against a mocked upstream.

## Disclaimer

This project is for **educational purposes only**, and we are **not liable** for any malicious
actions done by people using it.

Independent software, not affiliated with Codebuff, Freebuff, or OpenAI. Use with your own
accounts and in accordance with their terms. Free-tier routing depends on undocumented upstream
behavior and can break at any time.

## License

MIT
