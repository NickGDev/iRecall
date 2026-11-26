# MCP server (phase 4 — implemented)

Exposes the iRecall store to agents over **stdio** (`mcp/src/main.ts`). Pure HTTP
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
text stays in the DB) and wraps it in an untrusted-content envelope (advisory
— pages can forge delimiters) — page text is third-party data, never
instructions. Don't run this MCP alongside write-capable tools (shell, email,
filesystem, `teach_page`) without confirming actions.

## Run / register

```bash
# Claude Code (from the repo root)
claude mcp add irecall -- node "$PWD/node_modules/tsx/dist/cli.mjs" "$PWD/mcp/src/main.ts"

# Claude Desktop (claude_desktop_config.json)
{ "mcpServers": { "irecall": { "command": "node",
  "args": ["/absolute/path/to/irecall/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/irecall/mcp/src/main.ts"] } } }
```

Auth: reads the bearer token from `server/.token` on every call (survives token
regeneration). Trust boundary: same-machine = trusted — the token keeps web
pages out, not local processes. Server must be running:
`launchctl kickstart -k gui/$(id -u)/dev.irecall.server`.
