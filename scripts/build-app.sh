#!/bin/bash
# Build Recall.app — a self-contained bundle: node runtime, compiled server,
# prod node_modules, models, unpacked extension, tray app. Ad-hoc signed
# (unsigned: Gatekeeper asks for right-click-open on first launch).
# Requires: node, swiftc (Xcode CLT). Models fetched via scripts/fetch-models.sh
# if missing. Does not mutate the repo's node_modules (prunes a copy).
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$PROJECT/Recall.app"
ZIP="$PROJECT/Recall-app-macos-arm64.zip"
VERSION="$(node -p "require('$PROJECT/package.json').version")"

command -v swiftc >/dev/null || { echo "swiftc missing — install Xcode CLT"; exit 1; }

cd "$PROJECT"
echo "== build Recall.app $VERSION =="

echo "-- server + extension build"
npm run build:server
npm run build:ext

echo "-- models"
if [ ! -f server/models/julia-1.5-fp16/model.onnx ]; then
  ./scripts/fetch-models.sh
fi

echo "-- stage bundle"
rm -rf "$APP"
CONTENTS="$APP/Contents"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/app/server"

RES="$CONTENTS/Resources/app"
cp package.json "$RES/"
cp -R node_modules "$RES/node_modules"
(cd "$RES" && npm prune --omit=dev --no-fund --no-audit)
cp -R server/dist "$RES/server/dist"
mkdir -p "$RES/server/public"
cp server/public/index.html server/public/rules.html "$RES/server/public/"
cp -R server/models "$RES/server/models"
cp -R extension "$RES/extension"
rm -rf "$RES/extension/node_modules"

echo "-- node runtime"
cp "$(command -v node)" "$CONTENTS/MacOS/node"

echo "-- tray app (swiftc)"
swiftc -O scripts/RecallTray.swift -o "$CONTENTS/MacOS/Recall"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Recall</string>
  <key>CFBundleDisplayName</key><string>Recall</string>
  <key>CFBundleIdentifier</key><string>dev.recall.app</string>
  <key>CFBundleExecutable</key><string>Recall</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

echo "-- codesign (ad-hoc) + zip"
codesign --force --deep -s - "$APP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "built: $APP"
echo "zip:   $ZIP ($(du -h "$ZIP" | cut -f1))"
