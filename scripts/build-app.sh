#!/bin/bash
# Build the Recall bundle via the Tauri shell (src-tauri): Rust tray +
# supervisor (replaces the former swiftc tray). Stages node runtime, compiled
# server, prod node_modules, models, unpacked extension as Tauri resources,
# calls tauri build for the host target (macOS: Recall.app; other OSes in CI),
# ad-hoc signs, zips. Requires: node, npm, Rust toolchain (cargo) — tauri-cli
# via npx. Models fetched via scripts/fetch-models.sh if missing.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"
VERSION="$(node -p "require('$PROJECT/package.json').version")"

command -v cargo >/dev/null || { echo "cargo missing — install Rust (rustup)"; exit 1; }

echo "== build Recall.app (tauri) $VERSION =="

bash scripts/stage-runtime.sh

npx --yes "@tauri-apps/cli@^2" build --bundles app

SRC="src-tauri/target/release/bundle/macos/Recall.app"
[ -d "$SRC" ] || { echo "bundle missing: $SRC" >&2; exit 1; }

ARCH="$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")"
ZIP="Recall-app-macos-$ARCH.zip"

rm -rf Recall.app
cp -R "$SRC" Recall.app
codesign --force --deep -s - Recall.app

rm -f "$ZIP"
ditto -c -k --keepParent Recall.app "$ZIP"

echo "built: Recall.app"
echo "zip:   $ZIP ($(du -h "$ZIP" | cut -f1))"
