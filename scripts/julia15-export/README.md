# Julia-1.5 ONNX export

SupersonicLabs ships Julia-1.5 as safetensors + a packed-layout PyTorch runtime
(packed-token attention can't export to ONNX directly). These scripts
re-implement the identical math in padded [B, T] form and export the graph the
server runs (`server/models/julia-1.5`), then verify it against the vendor's
own fixtures (`runtime/tests/fixtures/reference.json` — parity 1e-4).

1. Fetch into a work dir: `model.safetensors`, `encoder/config.json`,
   `julia_config.json`, `tokenizer/`, `runtime/julia15/`, and
   `runtime/tests/fixtures/reference.json` from
   https://huggingface.co/SupersonicLabs/Julia-1.5
2. Point `CHECKPOINT` (padded_model.py) and `CHECKPOINT`/`OUT`
   (export_and_check.py) at that dir; `uv venv` + `uv pip install torch onnx
   onnxruntime onnxscript transformers`
3. `python padded_model.py` — torch parity vs vendor fixtures
4. `python export_and_check.py` — ONNX export + onnxruntime parity
5. Copy `model.onnx`, `model.onnx.data`, `tokenizer/*` into
   `server/models/julia-1.5/` (wasm/ tokenizer comes from Julia-1-ONNX — same
   tokenizer, sha-verified)

`export_and_check.py` must produce `PARITY PASS` before deployment. Input
contract matches Julia-1-ONNX (marker_mask bool), except `head_length` is 512.

Deployed export (2026-11-25): attention masks are additive float (`-1e9`,
`key_add`/`band_add`) rather than bool — the dynamo SDPA decomposition turns
bool masks into a `masked_fill` `Where` over [B,heads,T,T] per layer (22.7% of
runtime); additive masks decompose to a broadcast Add and benchmark ~29% faster
on full-budget (T=1024) pages — 209ms vs 292ms, beating the vendor's own
Julia-1-ONNX export (227ms) at identical parity (2.2e-4). External-data filename
is recorded from the export output name: export as `model.onnx` or ORT fails
path validation on load.
