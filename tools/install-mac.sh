#!/usr/bin/env bash
# commandcodex one-shot macOS installer.
#
#   tools/install-mac.sh
#
# Does everything:
#   1. Verifies Bun 1.4+
#   2. bun install + compiles the commandcodex bridge AND the catalog muxer
#   3. Installs both binaries on PATH (`commandcodex`, `commandcodex-mux`)
#   4. Installs + (re)starts both LaunchAgents (bridge :17999, muxer :17850)
#   5. Points Codex at the muxer — `commandcodex codex install` (reversible)
#   6. Restarts the Codex/ChatGPT app so the merged catalog is live
#
# Safe to re-run at any time (updates, config changes): every step is idempotent
# and your ~/.commandcodex/config.json (API key!) is never touched.

set -euo pipefail

# Resolve the checkout (script lives in <checkout>/tools).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_NAME="commandcodex"
MUX_NAME="commandcodex-mux"
INSTALL_DIR="/usr/local/bin"
FALLBACK_INSTALL_DIR="$HOME/bin"
LABEL="dev.commandcodex.serve"
MUX_LABEL="dev.commandcodex.mux"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MUX_PLIST="$HOME/Library/LaunchAgents/$MUX_LABEL.plist"
BRIDGE_URL="http://127.0.0.1:17999"
MUXER_URL="http://127.0.0.1:17850"
# The Codex desktop app's actual bundle name on this machine (it is not ChatGPT.app).
APP_CANDIDATES=(
  "/Applications/Codex Web GPT.app"
  "/Applications/ChatGPT.app"
)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

find_app() {
  for app in "${APP_CANDIDATES[@]}"; do
    [[ -d "$app" ]] && { echo "$app"; return 0; }
  done
  return 1
}

# ---------------------------------------------------------------- 1. bun
log "checking bun"
if ! command -v bun >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do
    if [[ -x "$candidate" ]]; then export PATH="$(dirname "$candidate"):$PATH"; break; fi
  done
fi
if ! command -v bun >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    log "installing bun via homebrew"
    brew install bun
  else
    warn "bun is required: install it with 'curl -fsSL https://bun.sh/install | bash' and re-run"
    exit 1
  fi
fi
BUN_VERSION="$(bun --version)"
case "$BUN_VERSION" in
  1.[4-9]*|1.[1-9][0-9]*|2.*) ;;                     # 1.4+ is fine
  *) warn "bun $BUN_VERSION found, but 1.4+ is recommended"; ;;
esac
echo "bun $BUN_VERSION"

# ---------------------------------------------------------------- 2. build
log "building binaries (bun ${BUN_VERSION})"
cd "$REPO_DIR"
bun install --frozen-lockfile
mkdir -p dist
bun build --compile --target=bun-darwin-arm64 --outfile dist/"$BIN_NAME" src/cli.ts
bun build --compile --target=bun-darwin-arm64 --outfile dist/"$MUX_NAME" src/muxer.ts
BRIDGE_BIN="$REPO_DIR/dist/$BIN_NAME"
MUXER_BIN="$REPO_DIR/dist/$MUX_NAME"

# ---------------------------------------------------------------- 3. install binaries
log "installing binaries on PATH"
install_to() {
  local src="$1" name="$2" dest=""
  if [[ -w "$INSTALL_DIR" ]] || mkdir -p "$INSTALL_DIR" 2>/dev/null && [[ -w "$INSTALL_DIR" ]]; then
    dest="$INSTALL_DIR/$name"
  else
    mkdir -p "$FALLBACK_INSTALL_DIR"
    dest="$FALLBACK_INSTALL_DIR/$name"
    case ":$PATH:" in
      *":$FALLBACK_INSTALL_DIR:"*) ;;
      *)
        for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
          if [[ -f "$rc" ]] && ! grep -qs 'bin commandcodex' "$rc"; then
            printf '\n# commandcodex (added by installer)\nexport PATH="$HOME/bin:$PATH"\n' >> "$rc"
          fi
        done
        warn "added $FALLBACK_INSTALL_DIR to PATH in ~/.zshrc / ~/.zprofile — open a new shell for it to apply"
        ;;
    esac
  fi
  cp -f "$src" "$dest"
  chmod +x "$dest"
  echo "installed: $dest"
  echo "$dest"
}
BRIDGE_INSTALLED="$(install_to "$BRIDGE_BIN" "$BIN_NAME")"
MUXER_INSTALLED="$(install_to "$MUXER_BIN" "$MUX_NAME")"
# Remove stale binaries from the buffcodex era so the old names stop working.
rm -f "$INSTALL_DIR/buffcodex" "$INSTALL_DIR/buffcodex-mux" "$FALLBACK_INSTALL_DIR/buffcodex" "$FALLBACK_INSTALL_DIR/buffcodex-mux" 2>/dev/null || true

# ---------------------------------------------------------------- 4. LaunchAgents
install_agent() {
  local label="$1" plist="$2" binary="$3"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/commandcodex.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/commandcodex.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart -k "gui/$(id -u)/$label"
}
log "installing LaunchAgents ($LABEL, $MUX_LABEL)"
install_agent "$LABEL" "$PLIST" "$BRIDGE_INSTALLED"
install_agent "$MUX_LABEL" "$MUX_PLIST" "$MUXER_INSTALLED"
# Unload the old buffcodex agents if they still exist.
for old in dev.buffcodex.serve dev.buffcodex.mux; do
  launchctl bootout "gui/$(id -u)/$old" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$old.plist" 2>/dev/null || true
done

# ---------------------------------------------------------------- 5. codex routing
CONFIG_DIR="${COMMANDCODEX_HOME:-$HOME/.commandcodex}"
KEY_SET="$(/usr/bin/python3 - "$CONFIG_DIR/config.json" <<'PY' 2>/dev/null || echo ""
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    key = cfg.get("apiKey", "")
    # Pre-rename spellings also count.
    if not key and isinstance(cfg.get("commancodex"), dict):
        key = cfg["commancodex"].get("apiKey", "")
    if not key and isinstance(cfg.get("commandCode"), dict):
        key = cfg["commandCode"].get("apiKey", "")
    print(1 if key else 0)
except Exception:
    print(0)
PY
)"
if [[ "${KEY_SET:-0}" -eq 1 ]]; then
  log "routing Codex through the bridge"
  "$BRIDGE_INSTALLED" codex install
else
  warn "no Provider API key configured yet — set one, then re-run this script:"
  warn "  $BRIDGE_INSTALLED set <commandcode-ai-api-key>"
fi

# ---------------------------------------------------------------- 6. restart the app
log "restarting the Codex/ChatGPT app"
if APP="$(find_app)"; then
  osascript -e 'tell application "Codex Web GPT" to quit' >/dev/null 2>&1 || true
  osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1 || true
  sleep 2
  open "$APP"
  echo "restarted: $APP"
else
  warn "no Codex/ChatGPT app found — skipping app restart"
fi

# ---------------------------------------------------------------- health check
log "waiting for the bridge"
for _ in $(seq 1 20); do
  if curl -fsS "$BRIDGE_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -fsS "$BRIDGE_URL/healthz" >/dev/null 2>&1; then
  warn "bridge did not come up — check ~/Library/Logs/commandcodex.log"
  exit 1
fi
MODELS="$(curl -fsS "$MUXER_URL/v1/models" 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)["models"]))' 2>/dev/null || echo "?")"
echo
echo "✅ commandcodex is running"
echo "   muxer:     $MUXER_URL/v1 — $MODELS models (native + Commancodex)"
echo "   bridge:    $BRIDGE_URL/v1"
