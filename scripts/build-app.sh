#!/bin/bash
# Build the iRecall bundle via the Tauri shell (src-tauri): Rust tray +
# supervisor (replaces the former swiftc tray). Stages node runtime, compiled
# server, prod node_modules, models, unpacked extension as Tauri resources,
# calls tauri build for the host target (macOS: iRecall.app; other OSes in CI),
# ad-hoc signs, zips. Requires: node, npm, Rust toolchain (cargo) — tauri-cli
# via npx. Models fetched via scripts/fetch-models.sh if missing.
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"
VERSION="$(node -p "require('$PROJECT/package.json').version")"

command -v cargo >/dev/null || { echo "cargo missing — install Rust (rustup)"; exit 1; }

echo "== build iRecall.app (tauri) $VERSION =="

bash scripts/stage-runtime.sh

npx --yes "@tauri-apps/cli@^2" build --bundles app

SRC="src-tauri/target/release/bundle/macos/iRecall.app"
[ -d "$SRC" ] || { echo "bundle missing: $SRC" >&2; exit 1; }

ARCH="$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")"
ZIP="iRecall-app-macos-$ARCH.zip"

rm -rf iRecall.app
cp -R "$SRC" iRecall.app
codesign --force --deep -s - iRecall.app

rm -f "$ZIP"
ditto -c -k --keepParent iRecall.app "$ZIP"

echo "built: iRecall.app"
echo "zip:   $ZIP ($(du -h "$ZIP" | cut -f1))"
