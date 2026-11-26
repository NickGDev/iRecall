# Resource-usage dogma

The product promise is "light enough to forget" — enforce it.

## Budgets

- Server sidecar: `--max-old-space-size=384` (spawned by the tray).
- Models on disk ~487 MB (julia fp16 + granite ONNX) — bundled into every
  release artifact. RAM cost is inference-time only.
- One node process + one tray process. No worker pool, no second server.
- Every capture does ≤ ~75 ms of model work (julia gate), embeddings are
  async and batched.

## Idle-aware worker (server)

All heavy work — embed drain, focus sweeps, retention purge, model warm-up
— runs in bounded slices on ONE 30 s tick, gated on loadavg
(`IDLE_LOAD = cpus/2`). Consequences to preserve:

- Browsing-time latency stays flat; backlog drains while the user is away.
- A never-idle machine degrades to keyword-only search (FTS is written at
  ingest) — acceptable, documented, never a crash or churn loop.
- Purge interval doubles as the hourly backfill hook (embed requeue).

## Extension hygiene

- Buffer lives in `storage.session` (dies with the browser — no disk
  leak), MAX_BUFFER 50 drop-oldest, flush at ≥5 pages or 30 s.
- Polls: scroll-growth 60 s, server sync 60 s. Nothing tighter without a
  measured reason.
- Badge states are the only continuous UI: ✓ saved / ✕ skipped / · thin /
  ● recording / ‖ paused.

## Bundle hygiene (keeps CI green + artifacts lean)

`scripts/stage-runtime.sh` strips three classes of dead ELFs after
`npm prune`. **Keep these strips and extend the pattern for any new native
dep** — linuxdeploy dies silently on foreign ELFs during AppImage bundling:

1. `onnxruntime-node` GPU providers: `*providers_cuda*`,
   `*providers_tensorrt*` — CPU inference never loads them.
2. `@img/*linuxmusl*` — sharp's musl variants (glibc runtime uses the
   glibc libs; musl ELFs link musl ld.so).
3. (`scripts/fetch-models.sh` mkdir + release `GH_TOKEN` — see release job.)

## Search scale

FTS5 + brute-force cosine KNN is deliberate at personal scale (~100
captures/day, thousands of vectors). The sqliteai/sqlite-vector swap is
deferred — revisit ONLY at >50k vectors or measured search-latency pain
(analysis on record: real delta is packed-SIMD scan vs per-row scalar fn,
not JS vs native; the failure mode changes from caught-throw to segfault).
