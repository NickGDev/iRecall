#!/bin/bash
# iRecall — one-shot mac installer: deps, model, extension build, LaunchAgent
# auto-start. Extension setup is Load-unpacked; the tray app walks the user
# through it on first run (Chrome blocks off-store auto-install).
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
UID_N="$(id -u)"
LABEL="dev.irecall.server"
PLIST_DST="$HOME/Library/LaunchAgents/dev.irecall.server.plist"

echo "== iRecall installer =="
echo "project: $PROJECT"

command -v node >/dev/null || { echo "node missing — install node first"; exit 1; }
if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then echo "Google Chrome missing"; exit 1; fi

echo "-- npm install"
cd "$PROJECT" && npm install --no-fund --no-audit

echo "-- download embedding model"
node scripts/download-model.mjs

echo "-- build extension"
npm run build:ext

echo "-- tray app (Tauri shell)"
# Cross-platform Rust tray (src-tauri) built by scripts/build-app.sh; build
# it on the spot when missing. Prefer an existing /Applications copy (survives
# app cleaners better); fall back to a project-local bundle.
APP_DST="$PROJECT/iRecall.app"
[ -d /Applications/iRecall.app ] && APP_DST="/Applications/iRecall.app"
[ -d "$APP_DST" ] || bash "$PROJECT/scripts/build-app.sh"
codesign --force --deep -s - "$APP_DST" 2>/dev/null || true
echo "tray app ($APP_DST: menu bar: state, dashboard, pause, quit)"

echo "-- LaunchAgent (auto-start + keepalive)"
mkdir -p "$HOME/Library/LaunchAgents"
# Compiled ESM (package.json is type:module) — no tsx loader in production.
(cd "$PROJECT" && npm run build:server) || { echo "server build failed"; exit 1; }
# Models are release artifacts, not repo files — fetch if missing.
if [ ! -f "$PROJECT/server/models/julia-1.5-fp16/model.onnx" ]; then
  "$PROJECT/scripts/fetch-models.sh"
fi
cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--max-old-space-size=384</string>
    <string>$PROJECT/server/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/server/server.log</string>
  <key>StandardErrPath</key><string>$PROJECT/server/server.log</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>Nice</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
</dict>
</plist>
EOF

# history DB + WAL are private: no other local account should read them
chmod 600 "$PROJECT/server/data/"irecall.db* 2>/dev/null || true

launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
# pre-rename agents (dev.recall.*) would fight the new ones for port 8787
launchctl bootout "gui/$UID_N/dev.recall.server" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/dev.recall.server.plist"
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
TRAY_PLIST="$HOME/Library/LaunchAgents/dev.irecall.tray.plist"
cat > "$TRAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.irecall.tray</string>
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
launchctl bootout "gui/$UID_N/dev.irecall.tray" 2>/dev/null || true
launchctl bootout "gui/$UID_N/dev.recall.tray" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/dev.recall.tray.plist"
launchctl bootstrap "gui/$UID_N" "$TRAY_PLIST" 2>/dev/null || true
launchctl kickstart "gui/$UID_N/dev.irecall.tray" 2>/dev/null || open -a iRecall
echo "tray: launched"

echo "== done =="
echo "1. the tray shows a setup window on first run — open chrome://extensions,"
echo "   enable Developer mode, Load unpacked ->"
echo "   ~/Library/Application Support/iRecall/extension"
