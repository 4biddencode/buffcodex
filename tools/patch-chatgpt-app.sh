#!/usr/bin/env bash
# Patch a COPY of the ChatGPT desktop app (in ~/Applications) to show live
# per-account buffcodex usage in the bottom-left account menu.
#
# - Never touches /Applications/ChatGPT.app (TCC-protected anyway)
# - Idempotent: re-copy from the original every run, so it survives app updates
#   — just re-run this script after the original updates.
# - Injects webview/assets/usage-panel.js + a <script> tag into webview/index.html
# - Extends the webview CSP connect-src with http://127.0.0.1:17999
# - Repacks app.asar, updates the ElectronAsarIntegrity hash in Info.plist,
#   and ad-hoc re-signs the bundle copy.
set -euo pipefail

SRC="/Applications/ChatGPT.app"
DST_DIR="$HOME/Applications"
DST="$DST_DIR/ChatGPT.app"
WORK="$(mktemp -d)"
BRIDGE_URL="http://127.0.0.1:17999"

if [[ ! -d "$SRC" ]]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

echo "==> copying app (this takes a moment)…"
rm -rf "$DST"
mkdir -p "$DST_DIR"
cp -R "$SRC" "$DST"

ASAR="$DST/Contents/Resources/app.asar"
echo "==> extracting asar…"
npx --yes @electron/asar extract "$ASAR" "$WORK/asar"

echo "==> injecting usage panel…"
# 1) the panel script itself (fetched fresh from the repo checkout if present,
#    otherwise the embedded copy in this script's directory)
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/usage-panel.js"
if [[ ! -f "$SCRIPT_SRC" ]]; then
  echo "error: $SCRIPT_SRC not found (run from the buffcodex checkout)" >&2
  exit 1
fi
cp "$SCRIPT_SRC" "$WORK/asar/webview/assets/usage-panel.js"

HTML="$WORK/asar/webview/index.html"
if ! grep -q 'usage-panel.js' "$HTML"; then
  # Insert before the first <script tag so it runs before app code.
  python3 - "$HTML" "$BRIDGE_URL" <<'PYEOF'
import sys
html_path, bridge = sys.argv[1], sys.argv[2]
html = open(html_path, encoding="utf-8").read()
tag = f'<script src="./assets/usage-panel.js"></script>'
html = html.replace("<script", f"{tag}<script", 1)
# Extend CSP so the panel may call the local bridge.
html = html.replace("connect-src &#x27;self&#x27;", f"connect-src &#x27;self&#x27; {bridge}")
html = html.replace("connect-src 'self'", f"connect-src 'self' {bridge}")
open(html_path, "w", encoding="utf-8").write(html)
print("patched index.html")
PYEOF
fi

echo "==> repacking asar…"
npx --yes @electron/asar pack "$WORK/asar" "$ASAR"

echo "==> updating asar integrity hash…"
HASH=$(shasum -a 256 "$ASAR" | awk '{print $1}')
PLIST="$DST/Contents/Info.plist"
python3 - "$PLIST" "$HASH" <<'PYEOF'
import plistlib, sys
plist_path, new_hash = sys.argv[1], sys.argv[2]
with open(plist_path, "rb") as f:
    plist = plistlib.load(f)
entry = plist.get("ElectronAsarIntegrity", {}).get("Resources/app.asar")
if entry is None:
    sys.exit("no ElectronAsarIntegrity entry found")
entry["hash"] = new_hash
with open(plist_path, "wb") as f:
    plistlib.dump(plist, f)
print("integrity hash updated")
PYEOF

echo "==> re-signing…"
codesign --force --deep --sign - "$DST" 2>/dev/null || codesign --force --sign - "$DST"

rm -rf "$WORK"
echo "==> done: $DST"
echo "    launch with: open \"$DST\""
