#!/bin/sh
# Ensure server/models has the runtime artifacts without shipping them in git.
# Prefers the latest GitHub release bundle; granite can also come straight
# from Hugging Face (public). No tokens needed for a public repo; for a
# private repo your local `gh` auth is used automatically.
set -eu
cd "$(dirname "$0")/.."

JULIA=server/models/julia-1.5-fp16/model.onnx
GRANITE_DIR=server/models/onnx-community/granite-embedding-small-english-r2-ONNX

needs_julia()   { [ ! -f "$JULIA" ]; }
needs_granite() { [ ! -f "$GRANITE_DIR/onnx/model_quantized.onnx" ]; }

if needs_julia || needs_granite; then
  REPO="${IRECALL_REPO:-}"
  if [ -z "$REPO" ] && command -v gh >/dev/null 2>&1; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  fi
  if [ -n "$REPO" ] && command -v gh >/dev/null 2>&1; then
    echo "-- downloading models bundle ($REPO latest release)"
    tmp=$(mktemp -d)
    if gh release download --repo "$REPO" -p 'irecall-models.tar.gz' -O "$tmp/models.tar.gz" --clobber; then
      tar -xzf "$tmp/models.tar.gz" -C server/models
    else
      echo "release download failed (no releases yet?) — falling back to HF for granite"
    fi
    rm -rf "$tmp"
  fi
fi

if needs_granite; then
  echo "-- fetching granite q8 from Hugging Face"
  gb=https://huggingface.co/onnx-community/granite-embedding-small-english-r2-ONNX/resolve/main
  for f in config.json special_tokens_map.json tokenizer.json tokenizer_config.json; do
    curl -fsSL -o "$GRANITE_DIR/$f" "$gb/$f"
  done
  curl -fsSL -o "$GRANITE_DIR/onnx/model_quantized.onnx" "$gb/onnx/model_quantized.onnx"
  curl -fsSL -o "$GRANITE_DIR/onnx/model_quantized.onnx_data" "$gb/onnx/model_quantized.onnx_data"
fi

if needs_julia; then
  echo "ERROR: julia-1.5-fp16 model missing and no release bundle available." >&2
  echo "Either run the release workflow (push a v* tag), or copy" >&2
  echo "server/models/julia-1.5-fp16 from another machine." >&2
  exit 1
fi
echo "models present"
