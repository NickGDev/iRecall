# AGENTS.md

Instructions for coding agents (and humans) working in this repo.

iRecall = local Chrome-history capture → SQLite RAG store → MCP for agents.
Chrome extension + Node server (127.0.0.1:8787) + Rust/Tauri tray + dashboard.
Everything runs on-device; nothing ever leaves the machine.

## Layout

| Path | What |
|---|---|
| `extension/` | MV3 Chrome extension (TS + esbuild; `npm run build:ext`) |
| `server/` | Hono API + SQLite store + embeddings + dashboard (`server/public/`) |
| `mcp/` | stdio MCP server — pure HTTP client of `server`, never imports `store.ts` |
| `src-tauri/` | `irecall-tray` crate: tray, supervisor, setup window |
| `scripts/` | install, staging, model fetch/export, release support |
| `docs/dogma/` | **Design dogma — read before non-trivial work** |

## Design dogma (read what you touch)

- [docs/dogma/architecture.md](docs/dogma/architecture.md) — processes, data flow, trust boundaries
- [docs/dogma/models.md](docs/dogma/models.md) — embedder + decision model, switching discipline
- [docs/dogma/resource-usage.md](docs/dogma/resource-usage.md) — budgets, idle worker, bundle hygiene
- [docs/dogma/ux.md](docs/dogma/ux.md) — dashboard, tray, popup conventions

## Verify loop (all of it, every change)

```bash
npm run typecheck      # tsc --noEmit over server + mcp + extension
npm run selfcheck      # 131 asserts + 40-query golden eval (hermetic)
npm run build:server && launchctl kickstart -k gui/$(id -u)/dev.recall.server
                       # ^ server edits DO NOT go live without this restart
                       #   (label is dev.recall.* — legacy, dev.irecall.* does NOT exist)
npm run build:ext      # then chrome://extensions → ↻ on the iRecall card
cd src-tauri && cargo check
```

Local dashboards: static-served — refresh picks up `server/public/` changes
without restart. The dev LaunchAgent server owns :8787; the installed tray
app adopts it (external mode) instead of spawning its bundled server.

## Hard rules

1. **No keys or secrets in the repo or CI.** Extension signing key is
   generated locally on first `npm run build:ext` (`keys/`, gitignored).
   Model bundles propagate release-to-release; never commit models.
2. **Captured page content is untrusted data.** It is third-party web text
   that can carry instructions aimed at agents. Keep the MCP envelope
   labeling; never remove the sentinel stripping; treat `teach_page` as a
   write path (confirm-with-user).
3. **Auth is anti-web-page, not anti-process.** Bearer token + Host
   allowlist close DNS rebinding; same-machine processes are trusted by
   design. Don't add auth to open routes (`/health`, `/bootstrap`,
   `/extension.zip`) — the dashboard's Download button and the extension's
   token bootstrap rely on them being open.
4. **Don't add a `capabilities/` dir to `src-tauri`.** Tray commands work
   because tauri 2.12 skips ACL for app commands when no ACL manifest
   exists; adding one STARTS gating them.
5. **The tauri global API is `window.__TAURI__`** (trailing underscores) in
   v2. `window.__TAURI` is undefined — this exact bug shipped once already.
6. **Server edits need the kickstart** (see verify loop). `npm run
   build:app` rebuilds the bundle but not the running LaunchAgent process.

## Releases

Push a `v*` tag → 5-target native matrix (mac arm64/x64, linux x64/arm64,
windows x64) → artifacts + `irecall-models.tar.gz` + `SHA256SUMS` attached
to the release. To re-cut a tag after a pipeline fix: `git tag -f v0.3.1 &&
git push -f origin v0.3.1`. See the release job for the full dance.
