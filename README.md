# Recall

Local, private record of Chrome pages you actually read — structured text captured
at the DOM layer (no screenshots, no OCR), stored in SQLite with hybrid keyword +
semantic search, agent-accessible via MCP (phase 4).

**Status: hybrid RAG live (capture → Julia-1 early filter → ingest → FTS5 +
Granite embeddings → hybrid search), Mac app packaging + Chrome force-install
via enterprise policy.** Phases 4–6 below.

## Install (macOS)

```bash
./scripts/install-mac.sh
```

Asks for your admin password once: the extension force-installs via the
device-level `ExtensionInstallForcelist` policy. Then quit Chrome fully and
reopen. Everything else is automatic:

- Server runs as a LaunchAgent (`dev.recall.server`) — auto-start at login,
  auto-restart on crash, logs to `server/server.log`
- Local models cached under `server/models` — fully offline after install:
  - `granite-embedding-small-english-r2` (IBM, 47M, 384-dim, 8k ctx) — search
    + focus-rule embeddings
  - `julia-1.5` (SupersonicLabs, 144.3M decision model) — early keep/drop; ONNX
    exported locally (no upstream ONNX export for 1.5) via `scripts/julia15-export/`,
    encoding `head_length: 512`
    filter, runs per page in ~10-75ms on CPU; tuned via `JULIA_THRESHOLD`
    (default 0.5) and disabled with `JULIA_DISABLE=1` (fail-open)
- Extension signed as CRX3 (`keys/recall-key.pem`, stable ID
  `cafcekahohdjjdgongnpbbigkgccokec`), served at
  `http://127.0.0.1:8787/updates.xml`, extension fetches its token from
  `/bootstrap` — no manual paste
- `Recall.app` — menu-bar tray app (compiled Swift, LSUIElement): white `R`
  monogram (white recording / dimmed paused / gray server-down),
  menu = status, Open Dashboard, Pause/Resume, Quit. Runs in background;
  starts at login via `dev.recall.tray` LaunchAgent. Recording flag lives on
  the server (`/config`) — tray, dashboard, popup all write there; the
  extension mirrors it within ~60s.
- Dashboard (http://127.0.0.1:8787/): search (hybrid), per-page delete,
  delete-by-domain, time wipes (24h/7d/30d/all), retention dropdown
  (auto-purge hourly), stats + recent pages.
- Auto-prune **focus rules** (`/rules` page): tell recall what to remember in
  plain language — e.g. "software engineering", "LLMs and prompting",
  "self-hosting", "MCP servers", "vector databases", "RAG". Two-tier filtering:
  rule keywords keep pages instantly, otherwise the **Julia-1 decision model**
  drops obvious noise before any embedding work, and pages that survive are
  judged semantically at the embed gate (Granite embedding cosine ≥ per-rule
  strictness) and swept hourly. The server tracks per-domain keep/reject
  stats and serves them at `/api/filterlist` — the extension syncs it every
  minute and stops capturing dead-cold domains at the source (a single keep
  permanently protects a domain; clear via `DELETE /api/filterlist`, and the
  rules page previews exactly what would be pruned (with similarity scores)
  before you
  save, and rules can be edited, disabled, or deleted anytime. Undecided pages
  (not yet embedded) are never deleted.
- Temporal RAG: every search hit carries `ageDays`, `supersededBy` (a newer
  capture of the same URL exists) and `stale` (superseded or >90d); ranking
  decays with age (~30d half-life). Agents can weigh staleness directly.

## Verify

```bash
npm run selfcheck    # 15 assertions: dedup, FTS, semantic, temporal, deletes
curl 127.0.0.1:8787/health
open http://127.0.0.1:8787/
```

Repack after extension changes: `npm run build:ext && npm run pack:ext`, bump
`version` in `manifest.json` for Chrome to auto-update the force-installed copy.

## Architecture

```
Chrome ext (MV3, force-installed)   Local server (127.0.0.1:8787, LaunchAgent)
├─ spy.js (MAIN world)              ├─ open: /health /bootstrap / (status page)
│   └─ history API hook (SPA nav)   │        /updates.xml /recall.crx
├─ content.js (isolated)            ├─ auth: /ingest /search /recent /stats
│   ├─ gates: paused / blocked      ├─ SQLite (WAL) + FTS5 + page_vectors
│   │   domains, password fields    │   (brute-force cosine KNN over blobs —
│   ├─ Readability on DOM clone      │    vec0 vtable broken w/ this build)
│   └─ min 250 chars else skip      ├─ hybrid search: bm25 + cosine KNN,
├─ background.js (service worker)   │   reciprocal rank fusion
│   ├─ /bootstrap token pre-wiring  ├─ embeddings: transformers.js (ONNX),
│   ├─ buffers in storage.session   │   granite-small r2 in-process, 384-dim
│   ├─ /api/filterlist 1-min sync   │   normalized; Julia-1 early gate (ORT)
│   └─ flush at batch≥5 or 30s      └─ token auth (server/.token)
└─ popup: pause, activity log, stats
```

## Privacy model

- All local: server binds `127.0.0.1` only; db at `server/data/recall.db`
  (mode 600 + FileVault protects at rest).
- Bearer token gates /ingest, /search, /recent, /pages/:id, /stats. Open routes:
  /health, /bootstrap, /, /updates.xml, /recall.crx (needed by Chrome's updater
  and first-run). A Host allowlist middleware rejects non-loopback Host headers,
  closing DNS rebinding.
- Trust boundary: the token defends against *web pages* (CORS/rebinding), not
  local processes — anything running as this user can read `server/.token` or
  `/bootstrap`. Same machine = trusted; FileVault covers at-rest.
- Never captured: pages with password fields, blocked domains (banking starter
  list), incognito, extracted text < 250 chars.
- Pause is enforced at the sink: the server stamps `recording_off_at` and drops
  any /ingest page captured after it (pre-pause buffer still lands). Popup
  `Pause` shows instantly via local mirror; server is the source of truth.
- Force-install policy caveat: Chrome prevents removing the extension from
  chrome://extensions (enterprise behavior, as requested). Remove policy via
  `defaults delete com.google.Chrome ExtensionInstallForcelist` + Chrome restart.
  The installer merges into any existing forcelist rather than replacing it.

## MCP (agents)

`recall` MCP server (stdio) wraps the HTTP API for Claude Code / Claude Desktop:

```bash
claude mcp add recall -- node /Users/nick/dev/recall/node_modules/tsx/dist/cli.mjs /Users/nick/dev/recall/mcp/src/main.ts
```

Tools: `search_history(q, domain?, since?, until?, limit?)` — hybrid search with
staleness flags; `get_page(id)` — full page text (truncated at 20k chars);
`recent_history(hours)` — newest captures in a window. Reads the token from
`server/.token` per call; never touches SQLite or the model directly.

## Roadmap

1. ✅ Extension capture (Readability + gates + SPA nav)
2. ✅ Server: SQLite + FTS5, dedup, search API
3. ✅ Hybrid semantic search (transformers.js MiniLM + sqlite-vec scalar fns)
4. ✅ MCP server (mcp/): search_history, get_page, recent_history (stdio)
5. ✅ Privacy UX: dashboard search + per-page/domain/age deletes, retention purge,
   time-window wipes
6. Enrichment worker (summaries, tags, sensitive classify — idle-time, async);
   PDF path (byte extraction, OCR fallback for scans) — no continuous OCR ever.
