#!/bin/bash
# Fetch the official Node.js dist binary for a Rust target triple and place it
# from nodejs.org — the Tauri resource sidecar (src-tauri/binaries/node-<triple>).
# Verified against nodejs.org SHASUMS256.txt. Cached: skips when dest exists.
# Usage: fetch-node.sh <target-triple> <dest-path>
set -euo pipefail

# Pinned LTS matching CI setup-node 22 and dev machines (node 22.x ABI for
# better-sqlite3/onnxruntime-node natives).
NODE_VERSION=22.23.2
TRIPLE="${1:?target triple required}"
DEST="${2:?dest path required}"

case "$TRIPLE" in
  aarch64-apple-darwin)      SYS=darwin-arm64; EXT=tar.gz ;;
  x86_64-apple-darwin)       SYS=darwin-x64;   EXT=tar.gz ;;
  x86_64-unknown-linux-gnu)  SYS=linux-x64;    EXT=tar.gz ;;
  aarch64-unknown-linux-gnu) SYS=linux-arm64;  EXT=tar.gz ;;
  x86_64-pc-windows-msvc)    SYS=win-x64;      EXT=zip ;;
  *) echo "unsupported target triple: $TRIPLE" >&2; exit 1 ;;
esac

if [ -f "$DEST" ]; then
  echo "node sidecar resource: $DEST"
  exit 0
fi

BASE="https://nodejs.org/dist/v$NODE_VERSION"
ARCHIVE="node-v$NODE_VERSION-$SYS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "-- fetching node $NODE_VERSION ($SYS)"
curl -fsSL -o "$TMP/$ARCHIVE.$EXT" "$BASE/$ARCHIVE.$EXT"
curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
(
  cd "$TMP"
  sha256sum -c - < <(grep " $ARCHIVE.$EXT\$" SHASUMS256.txt) 2>/dev/null ||
    shasum -a 256 -c <(grep " $ARCHIVE.$EXT\$" SHASUMS256.txt)
) || { echo "SHASUMS256 verify failed for $ARCHIVE.$EXT" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
if [ "$EXT" = tar.gz ]; then
  tar -xzf "$TMP/$ARCHIVE.$EXT" -C "$TMP"
  cp "$TMP/$ARCHIVE/bin/node" "$DEST"
else
  # git-bash: powershell for the zip (unzip not guaranteed on runners)
  P_IN="$(cygpath -w "$TMP/$ARCHIVE.zip" 2>/dev/null || echo "$TMP/$ARCHIVE.zip")"
  P_OUT="$(cygpath -w "$TMP/x" 2>/dev/null || echo "$TMP/x")"
  powershell.exe -NoProfile -Command "Expand-Archive -Force -LiteralPath '$P_IN' -DestinationPath '$P_OUT'" ||
    unzip -q "$TMP/$ARCHIVE.zip" -d "$TMP/x"
  cp "$TMP/x/$ARCHIVE/node.exe" "$DEST"
fi
chmod 755 "$DEST"
echo "node sidecar: $DEST"
