# Architecture dogma

Four processes, one machine. No cloud, ever.

```
Chrome ext (MV3)  →  server (Hono, 127.0.0.1:8787)  ←  tray (Tauri/Rust)
      ↑ sync 1min         ↓ SQLite WAL + FTS5            ↓ supervises
      └──────────────  MCP server (stdio) → agents      bundled node sidecar
```

## Capture flow (extension → DB)

1. **Gates first** (content.ts): paused? blocked domain (server list +
   filterlist mirror)? password field? extracted text < 250 chars? → skip
   silently at the source.
2. **Buffer**: serialized enqueue chain, seq-keyed items in
   `storage.session`, MAX_BUFFER 50 drop-oldest. Flush at batch ≥ 5 or
   30 s; scroll-growth re-capture on 60 s poll (≥ 1500 char growth).
3. **Ingest sink** (`server/src/store.ts`) — ALL policy lives here:
   recording gate (`recording_off_at` timestamp, not boolean),
   focus-rule verdicts (julia early gate → keyword-first keep → embedding
   verdict), dedup, same-URL supersede (older row gets `supersededBy`).
4. **Embed drain**: 3 attempts then drop+log; hourly backfill sweeps
   un-embedded pages. Embeddings only, never at capture time.

## Search

Hybrid: SQLite FTS5 bm25 ⊕ brute-force cosine KNN over `page_vectors`
blobs (vec_distance_cosine scalar fn — **vec0 vtable is broken with this
better-sqlite3/sqlite-vec build; don't "fix" it back**). Reciprocal rank
fusion, then `annotate()` (ageDays, stale > 90 d, supersededBy, decay
~30 d half-life), then normalized `score` (rank/maxRank POST-annotate —
never filter on raw RRF rank, ratios are flat ~0.98). Vec leg has a
relevance floor: distance ≥ 0.85 = unrelated (embedder-specific; see
models.md). Filters (domain/since/until/category/minScore) apply to both
legs; the www. prefix is stripped on both sides of domain matches.

## Ownership rules

- **Server is the single source of truth**: recording flag, blocklist
  (`blocked_domains`), focus rules, retention rules (settings KV), filter
  stats, extension last-seen. Extension + tray + dashboard poll/mirror;
  nothing authoritative lives in the extension.
- **MCP is a thin HTTP client** of the server. It never imports store.ts —
  that boundary keeps the API honest for non-Node clients.
- **Tray supervisor**: polls /health → /config every 5 s; if the port is
  already served it adopts (external mode — no spawn, no kill); otherwise
  spawns the bundled node sidecar and respawns on death. This adoption is
  what makes dev-LaunchAgent + installed-app coexist peacefully. Don't
  make it kill the port owner.

## Trust boundaries

- Token (`server/.token`, 0600) defends against *web pages* (DNS
  rebinding closed by Host allowlist), not local processes. Same machine
  = trusted. `/bootstrap` hands the token to any local caller on purpose.
- Captured page content is **untrusted third-party text** that may contain
  prompt-injection. MCP envelopes label it, forgeable fence sentinels are
  stripped, `get_page` truncates at 20k chars. Keep all three.
- `teach_page` is a write path — agents should confirm with their user
  before calling it.
