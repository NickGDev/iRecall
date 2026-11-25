#!/bin/bash
# Recall — one-shot mac installer: deps, model, extension CRX + update feed,
# LaunchAgent auto-start, Chrome force-install policy.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
UID_N="$(id -u)"
LABEL="dev.recall.server"
PLIST_DST="$HOME/Library/LaunchAgents/dev.recall.server.plist"

echo "== Recall installer =="
echo "project: $PROJECT"

command -v node >/dev/null || { echo "node missing — install node first"; exit 1; }
if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then echo "Google Chrome missing"; exit 1; fi

echo "-- npm install"
cd "$PROJECT" && npm install --no-fund --no-audit

echo "-- download embedding model"
node scripts/download-model.mjs

echo "-- build + pack extension"
npm run build:ext
node scripts/pack-extension.mjs
EXT_ID="$(sed -n 's/.*appid="\([a-p]\{32\}\)".*/\1/p' "$PROJECT/server/public/updates.xml")"
echo "extension id: $EXT_ID"

echo "-- tray app (swiftc)"
# Prefer an existing /Applications copy (survives app cleaners better); fall
# back to a project-local bundle.
APP_DST="$PROJECT/Recall.app"
[ -d /Applications/Recall.app ] && APP_DST="/Applications/Recall.app"
if command -v swiftc >/dev/null 2>&1; then
  swiftc -O scripts/RecallTray.swift -o "$APP_DST/Contents/MacOS/Recall"
  codesign --sign - --force "$APP_DST/Contents/MacOS/Recall" 2>/dev/null || true
  echo "tray app compiled ($APP_DST: menu bar: state, dashboard, pause, quit)"
else
  mkdir -p "$APP_DST/Contents/MacOS"
  cp scripts/recall-launcher.sh "$APP_DST/Contents/MacOS/Recall"
  echo "swiftc missing — bash launcher fallback (no tray icon)"
fi
chmod +x "$APP_DST/Contents/MacOS/Recall"

echo "-- LaunchAgent (auto-start + keepalive)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT/node_modules/tsx/dist/cli.mjs</string>
    <string>$PROJECT/server/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/server/server.log</string>
  <key>StandardErrPath</key><string>$PROJECT/server/server.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
</dict>
</plist>
EOF

# history DB + WAL are private: no other local account should read them
chmod 600 "$PROJECT/server/data/"recall.db* 2>/dev/null || true

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
lsof -ti tcp:8787 | xargs kill 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$UID_N" "$PLIST_DST" 2>/dev/null || true
launchctl kickstart -k "gui/$UID_N/$LABEL"
ok=""
for i in $(seq 1 15); do
  if curl -s -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] && echo "server: running" || { echo "server failed to start — see server/server.log"; exit 1; }

echo "-- tray app LaunchAgent (starts at login)"
TRAY_PLIST="$HOME/Library/LaunchAgents/dev.recall.tray.plist"
cat > "$TRAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.recall.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>open</string>
    <string>$APP_DST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
EOF
launchctl bootout "gui/$UID_N/dev.recall.tray" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$TRAY_PLIST" 2>/dev/null || true
launchctl kickstart "gui/$UID_N/dev.recall.tray" 2>/dev/null || open -a Recall
echo "tray: launched"

echo "-- Chrome force-install policy (requires admin password)"
# Machine-level policy (root-owned /Library/Preferences): the only policy tier
# that may still fetch self-hosted CRX on Chrome 137+. Merge into any existing
# forcelist instead of replacing it; dedupe by extension id.
EXISTING="$(sudo defaults read /Library/Preferences/com.google.Chrome ExtensionInstallForcelist 2>/dev/null | grep -o '"[^"]*"' | tr -d '"' || true)"
ENTRIES=()
for e in $EXISTING; do
  [ -n "$e" ] || continue
  [ "${e%%;*}" = "$EXT_ID" ] && continue
  ENTRIES+=("$e")
done
ENTRIES+=("$EXT_ID;http://127.0.0.1:8787/updates.xml")
if sudo defaults write /Library/Preferences/com.google.Chrome ExtensionInstallForcelist -array "${ENTRIES[@]}"; then
  echo "policy written (device-level ExtensionInstallForcelist, ${#ENTRIES[@]} entry/entries)"
else
  echo "WARNING: could not write Chrome policy (no admin rights?)"
  echo "  fallback: chrome://extensions -> Developer mode -> Load unpacked -> $PROJECT/extension"
fi

echo "== done =="
echo "1. quit Chrome fully and reopen"
echo "   Chrome ≥137 honors force-install only on MDM-managed browsers —"
echo "   if the extension doesn't appear: chrome://extensions -> Developer mode"
echo "   -> Load unpacked -> $PROJECT/extension"
