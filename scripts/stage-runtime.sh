#!/bin/bash
# Stage the runtime payload the Tauri shell bundles as resources
# (tauri.conf.json: bundle.resources):
#   src-tauri/binaries/node-<triple>   official node dist for the target
#   src-tauri/binaries/server/         package.json + prod node_modules +
#                                      dist + public + models (server tree)
#   src-tauri/binaries/extension/      unpacked extension
# The staging dir is wiped each run so stale triples never ride along into
# the bundle. Called by scripts/build-app.sh and the release workflow.
# Usage: stage-runtime.sh [target-triple]  (default: host triple via rustc)
set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT"

TRIPLE="${1:-$(rustc -vV | awk '/^host:/{print $2}')}"
STAGE="src-tauri/binaries"

command -v rustc >/dev/null || { echo "rustc missing — install Rust (rustup)"; exit 1; }

echo "== stage runtime ($TRIPLE) =="

echo "-- server + extension build"
npm run build:server
npm run build:ext

echo "-- models"
if [ ! -f server/models/julia-1.5-fp16/model.onnx ]; then
  ./scripts/fetch-models.sh
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/server"

echo "-- node sidecar"
bash scripts/fetch-node.sh "$TRIPLE" "$STAGE/node-$TRIPLE"
if [ ! -f "$STAGE/node-$TRIPLE.exe" ] && [ ! -f "$STAGE/node-$TRIPLE" ]; then
  echo "node sidecar missing" >&2
  exit 1
fi

echo "-- server tree (prod node_modules; repo node_modules untouched)"
# cwd layout mirrors the old .app: server expects dist/public/models as
# siblings of package.json, with node_modules resolving up-tree from dist/.
cp package.json "$STAGE/server/"
cp -R node_modules "$STAGE/server/node_modules"
(cd "$STAGE/server" && npm prune --omit=dev --no-fund --no-audit)
# GPU-only execution providers (CUDA, TensorRT): never loaded for CPU
# inference, hundreds of MB of bloat in every bundle, and their ELFs kill
# linuxdeploy during AppImage bundling. Keep libonnxruntime + shared/CPU only.
find "$STAGE/server/node_modules/onnxruntime-node/bin" \
  \( -name '*providers_cuda*' -o -name '*providers_tensorrt*' \) -delete 2>/dev/null || true
# sharp's musl libs (libvips + binding): dead weight on glibc runtimes (sharp
# picks the glibc variant itself); musl ELFs trip linuxdeploy's dep scan.
find "$STAGE/server/node_modules/@img" -maxdepth 1 -name '*linuxmusl*' \
  -type d -exec rm -rf {} + 2>/dev/null || true
cp -R server/dist "$STAGE/server/dist"
cp -R server/public "$STAGE/server/public"
cp -R server/models "$STAGE/server/models"

echo "-- extension (unpacked)"
cp -R extension "$STAGE/extension"
rm -rf "$STAGE/extension/node_modules"

echo "staged: $STAGE"
