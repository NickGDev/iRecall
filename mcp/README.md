# MCP server (phase 4 — implemented)

Exposes the recall store to agents over **stdio** (`mcp/src/main.ts`). Pure HTTP
client of the local server — never imports `store.ts`, opens SQLite, or loads
the embedding model. Single DB writer and all validation stay server-side.

## Tools

| Tool | Args | Calls |
|---|---|---|
| `search_history` | `q` (required), `domain?`, `since?` (epoch ms), `until?`, `limit?` (1-100) | `GET /search` |
| `get_page` | `id` (from search/recent) | `GET /pages/:id` |
| `recent_history` | `hours?` (default 24, capped 2400) | `GET /recent?limit=200&since=…` |

`search_history` / `recent_history` results carry the temporal annotations
(`ageDays`, `supersededBy`, `stale`) so agents can weigh freshness. `get_page`
truncates content at 20,000 chars to protect the agent context window (full
text stays in the DB).

## Run / register

```bash
# Claude Code (from the repo root)
claude mcp add recall -- node "$PWD/node_modules/tsx/dist/cli.mjs" "$PWD/mcp/src/main.ts"

# Claude Desktop (claude_desktop_config.json)
{ "mcpServers": { "recall": { "command": "node",
  "args": ["/absolute/path/to/recall/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/recall/mcp/src/main.ts"] } } }
```

Auth: reads the bearer token from `server/.token` on every call (survives token
regeneration). Trust boundary: same-machine = trusted — the token keeps web
pages out, not local processes. Server must be running:
`launchctl kickstart -k gui/$(id -u)/dev.recall.server`.
