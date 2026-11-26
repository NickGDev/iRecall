# Model dogma

Two on-device models. CPU-only. No downloads at runtime (vendored under
`server/models/`; release bundles carry them).

## Embedder — granite-embedding-small-english-r2

- IBM ModernBERT, 47M params, **384 dims** (matches `page_vectors` schema —
  do not change dims without a migration), 8k context but the pipeline caps
  extracted text at MAX_CHARS 12000.
- Loaded via transformers.js `AutoModel` + `AutoTokenizer` — **not** the
  feature-extraction pipeline; the ONNX emits `sentence_embedding` directly.
- Embeddings L2-normalized. Unrelated-page baseline similarity for this
  embedder is 0.72–0.75 → the search vec leg drops rows at distance ≥ 0.85
  (`store.ts`). **This const is embedder-specific — re-tune it on any model
  swap**, or filtered searches return confident garbage (no-relevance-floor
  bug, already fixed once).
- **Switching models**: settings key `embed_model` ≠ `EMBED_MODEL` →
  server wipes `page_vectors` + focus-rule `topic_vecs` and re-embeds
  lazily. Focus rules keep their topics; they re-embed on next sweep.
- onnxruntime-node is **pinned** (1.30.0): 1.31.1 ships JS/native version
  skew (API-31 errors). Don't float it.

## Decision model — julia-1.5-fp16

- SupersonicLabs 144M keep/drop gate, runs BEFORE the embed verdict at
  ingest. Exported locally via `scripts/julia15-export/` (torch export →
  `PARITY PASS` grep gate → `quantize_q8.py`); don't hand-edit the ONNX.
- Accuracy is ~73% typed decisions → **noise filter only**, never the sole
  authority. Fail-open: `JULIA_DISABLE=1` disables; threshold via
  `JULIA_THRESHOLD` (default 0.5).
- transformers.js gotchas that cost real debugging time — don't regress:
  - tokenizer has `cls_token_id` undefined (TokenizersBackend bug) → use
    `bos_token_id` (2).
  - Call `tokenizer(...)` directly, never `.encode()`.
  - Budget < 16 shrink path must re-slice the real input arrays.

## Rank/score discipline

- RRF fusion produces flat scores (~0.98 adjacent) — absolute cutoffs on
  raw rank are meaningless. Confidence filtering happens only on the
  normalized `score` (rank/maxRank, computed after decay) with preset
  buckets (≥40/70/85% work; fine-grained minScore doesn't separate).
- KNN returns k nearest for ANY query — always keep the relevance floor
  (above), or filter-negative queries return confident nonsense.
