#!/usr/bin/env bash
# buffcodex one-shot macOS installer.
#
#   tools/install-mac.sh
#
# Does everything:
#   1. Verifies Bun 1.4+ (the runtime the freebuff CLI uses)
#   2. bun install + compiles the buffcodex binary
#   3. Installs the binary as `buffcodex` (on PATH everywhere)
#   4. Installs + (re)starts the LaunchAgent so the bridge runs in the background
#   5. Points Codex at the bridge (reversible ~/.codex/config.toml edit)
#   6. Restarts the (original) ChatGPT app so the new model catalog is live
#
# Safe to re-run at any time (updates, config changes): every step is idempotent
# and your ~/.buffcodex/config.json (accounts!) is never touched.

set -euo pipefail

# Resolve the checkout (script lives in <checkout>/tools).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_NAME="buffcodex"
INSTALL_DIR="/usr/local/bin"
FALLBACK_INSTALL_DIR="$HOME/bin"
LABEL="dev.buffcodex.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="/Applications/ChatGPT.app"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

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
  *) warn "bun $BUN_VERSION found, but 1.4+ is recommended (freebuff CLI parity)"; ;;
esac
echo "bun $BUN_VERSION"

# ---------------------------------------------------------------- 2. build
log "building binary (bun ${BUN_VERSION})"
cd "$REPO_DIR"
bun install --frozen-lockfile
mkdir -p dist
bun build --compile --target=bun-darwin-arm64 --outfile dist/"$BIN_NAME" src/cli.ts
BIN_PATH="$REPO_DIR/dist/$BIN_NAME"

# ---------------------------------------------------------------- 3. install binary
log "installing binary on PATH"
install_path=""
if [[ -w "$INSTALL_DIR" ]] || mkdir -p "$INSTALL_DIR" 2>/dev/null && [[ -w "$INSTALL_DIR" ]]; then
  install_path="$INSTALL_DIR/$BIN_NAME"
else
  mkdir -p "$FALLBACK_INSTALL_DIR"
  install_path="$FALLBACK_INSTALL_DIR/$BIN_NAME"
  case ":$PATH:" in
    *":$FALLBACK_INSTALL_DIR:"*) ;;
    *)
      for rc in "$HOME/.zshrc" "$HOME/.zprofile"; do
        if [[ -f "$rc" ]] && ! grep -qs "bin buffcodex" "$rc"; then
          printf '\n# buffcodex (added by installer)\nexport PATH="$HOME/bin:$PATH"\n' >> "$rc"
        fi
      done
      warn "added $FALLBACK_INSTALL_DIR to PATH in ~/.zshrc / ~/.zprofile — open a new shell for it to apply"
      ;;
  esac
fi
cp -f "$BIN_PATH" "$install_path"
chmod +x "$install_path"
echo "installed: $install_path"

# ---------------------------------------------------------------- 4. LaunchAgent
log "installing LaunchAgent ($LABEL)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$install_path</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/buffcodex.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/buffcodex.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# ---------------------------------------------------------------- 5. codex routing
CONFIG_DIR="${BUFFCODEX_HOME:-$HOME/.buffcodex}"
TOKENS="$(/usr/bin/python3 - "$CONFIG_DIR/config.json" <<'PY' 2>/dev/null || echo ""
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
    print(len([t for t in cfg.get("authTokens", []) if t]))
except Exception:
    print(0)
PY
)"
if [[ "${TOKENS:-0}" -ge 1 ]]; then
  log "routing Codex through the bridge"
  "$install_path" codex install
else
  warn "no accounts configured yet — add one, then re-run this script:"
  warn "  $install_path accounts add <freebuff-auth-token>"
fi

# ---------------------------------------------------------------- 6. restart ChatGPT
log "restarting ChatGPT"
if [[ -d "$APP" ]]; then
  osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1 || true
  sleep 2
  open "$APP"
else
  warn "$APP not found — skipping ChatGPT restart"
fi

# ---------------------------------------------------------------- health check
log "waiting for the bridge"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:17999/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if curl -fsS "http://127.0.0.1:17999/healthz" >/dev/null 2>&1; then
  MODELS="$(curl -fsS "http://127.0.0.1:17999/v1/models" | /usr/bin/python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"]))' 2>/dev/null || echo "?")"
  echo
  echo "✅ buffcodex is running — $MODELS models served at http://127.0.0.1:17999/v1"
  echo "   logs:     ~/Library/Logs/buffcodex.log"
  echo "   service:  launchctl kickstart -k gui/\$(id -u)/$LABEL"
  [[ "${TOKENS:-0}" -ge 1 ]] || echo "   next:     add an account (see above), then restart Codex/ChatGPT"
else
  warn "bridge did not come up — check ~/Library/Logs/buffcodex.log"
  exit 1
fi
