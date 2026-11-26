// iRecall MCP server (phase 4): exposes the local browsing history to agents
// over stdio. Pure HTTP client of the iRecall server — never imports store.ts,
// opens SQLite, or loads the model. Single DB writer stays the server; one
// validation path stays the process: the HTTP API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const SERVER = 'http://127.0.0.1:8787';
const TOKEN_PATH = path.join(ROOT, 'server', '.token');
// Page content can be 2MB — far too big for an agent context window. Return a
// generous head; the full text stays server-side.
const MAX_PAGE_CHARS = 20_000;

function readToken(): string {
  // Re-read per call: the server regenerates server/.token if it was ever
  // empty/corrupt, so a cached copy can go stale.
  return readFileSync(TOKEN_PATH, 'utf8').trim();
}

interface ApiHit {
  id: number;
  url: string;
  domain: string;
  title: string | null;
  snippet: string;
  capturedAt: number;
  dwellMs: number;
  rank: number;
  ageDays: number;
  supersededBy: number | null;
  stale: boolean;
}

interface ApiPage extends Omit<ApiHit, 'snippet' | 'rank' | 'ageDays' | 'supersededBy' | 'stale'> {
  content: string;
  excerpt: string | null;
  byline: string | null;
}

async function api(pathAndQuery: string, opts?: { method?: string; body?: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${pathAndQuery}`, {
      method: opts?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${readToken()}`,
        ...(opts?.body ? { 'content-type': 'application/json' } : {}),
      },
      body: opts?.body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      `iRecall server unreachable at ${SERVER}. Start it: launchctl kickstart -k gui/$(id -u)/dev.irecall.server`
    );
  }
  if (res.status === 401) {
    throw new Error('iRecall token rejected (server/.token stale?). Next call re-reads the file.');
  }
  if (!res.ok) throw new Error(`iRecall API ${pathAndQuery} failed: HTTP ${res.status}`);
  return res.json();
}

function hitLine(h: ApiHit): string {
  const flags = [h.stale ? 'stale' : null, h.supersededBy !== null ? `superseded by #${h.supersededBy}` : null]
    .filter(Boolean)
    .join(', ');
  return [`#${h.id}`, `${Math.round(h.ageDays * 10) / 10}d ago`, h.domain, h.title ?? '(untitled)', flags || null, h.url]
    .filter(Boolean)
    .join(' | ');
}

const server = new McpServer({ name: 'irecall', version: '0.1.0' });

server.registerTool(
  'search_history',
  {
    description:
      'Search the local browsing-history memory: pages the user actually read, ranked by relevance with time decay. ' +
      'Hybrid keyword + semantic; returns id/url/domain/title/snippet/age plus staleness flags. Use get_page for full text.',
    inputSchema: {
      q: z.string().min(1).describe('search query, e.g. "sqlite fts5" or a concept'),
      domain: z.string().optional().describe('restrict to one hostname, e.g. "sqlite.org"'),
      since: z.number().optional().describe('epoch ms — only pages captured at or after this'),
      until: z.number().optional().describe('epoch ms — only pages captured at or before this'),
      limit: z.number().int().min(1).max(100).optional().describe('max hits (default 20)'),
    },
  },
  async ({ q, domain, since, until, limit }) => {
    const p = new URLSearchParams({ q });
    if (domain) p.set('domain', domain);
    if (since !== undefined) p.set('since', String(Math.round(since)));
    if (until !== undefined) p.set('until', String(Math.round(until)));
    if (limit !== undefined) p.set('limit', String(limit));
    const data = (await api(`/search?${p}`)) as { hits: ApiHit[] };
    const text =
      data.hits.length === 0
        ? 'no matches'
        : data.hits.map((h) => `${hitLine(h)}\n    ${(h.snippet ?? '').replace(/\s+/g, ' ').trim()}`).join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'get_page',
  {
    description:
      'Fetch one captured page in full (url, title, byline, capturedAt, dwellMs, content). ids come from search_history/recent_history.',
    inputSchema: {
      id: z.number().int().positive().describe('page id from search_history or recent_history'),
    },
  },
  async ({ id }) => {
    const page = (await api(`/pages/${id}`)) as ApiPage;
    const text = [
      `# ${page.title ?? '(untitled)'}`,
      `${page.url}`,
      `domain: ${page.domain} | captured: ${new Date(page.capturedAt).toISOString()} | dwell: ${Math.round(page.dwellMs / 1000)}s`,
      page.byline ? `byline: ${page.byline}` : null,
      '',
      page.content.length > MAX_PAGE_CHARS
        ? page.content.slice(0, MAX_PAGE_CHARS) + `\n[…truncated at ${MAX_PAGE_CHARS} chars]`
        : page.content,
    ]
      .filter((l) => l !== null)
      .join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'recent_history',
  {
    description:
      'List recently captured pages, newest first, within a look-back window. Use for "what was I reading" questions.',
    inputSchema: {
      hours: z.number().optional().describe('look-back window in hours (default 24)'),
    },
  },
  async ({ hours }) => {
    const h = hours !== undefined && Number.isFinite(hours) && hours > 0 ? Math.min(hours, 2400) : 24;
    const since = Date.now() - h * 3_600_000;
    const data = (await api(`/recent?limit=200&since=${since}`)) as { pages: ApiHit[] };
    const text = data.pages.length === 0 ? 'no pages in that window' : data.pages.map(hitLine).join('\n');
    return { content: [{ type: 'text', text }] };
  }
);

server.registerTool(
  'teach_page',
  {
    description:
      'Teach the memory to keep pages like this one: stores the page as an exemplar, and future pages similar to it ' +
      'survive the focus filter. Pass a page you are currently reading (its url, title and the text you have). ' +
      'Use when the user says to remember/keep this kind of page or site.',
    inputSchema: {
      url: z.string().url().describe('page URL (http/https)'),
      title: z.string().optional().describe('page title'),
      content: z.string().min(1).max(2_000_000).describe('page text — the more representative, the better'),
    },
  },
  async ({ url, title, content }) => {
    const data = (await api('/api/exemplars', {
      method: 'POST',
      body: JSON.stringify({ url, title, content }),
    })) as { exemplar?: { id: number }; error?: string };
    const text = data.exemplar
      ? `taught: exemplar #${data.exemplar.id} stored — similar pages will now be kept`
      : `teach failed: ${data.error ?? 'unknown error'}`;
    return { content: [{ type: 'text', text }] };
  }
);

await server.connect(new StdioServerTransport());
