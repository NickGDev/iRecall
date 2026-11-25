import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Next } from 'hono';
import { createStore, type PageInput } from './store.js';
import { earlyFilter, setFocusCriteria } from './julia.js';

const PORT = 8787;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TOKEN_PATH = path.join(root, '.token');
const DB_PATH = path.join(root, 'data', 'recall.db');
const PUBLIC_DIR = path.join(root, 'public');

const store = createStore(DB_PATH);

function refreshCriteria(): void {
  const rules = store.listFocusRules().filter((r) => r.enabled);
  setFocusCriteria(rules.flatMap((r) => r.topics), rules.flatMap((r) => r.keywords));
}
refreshCriteria();

// --- early-filter feedback stats ----------------------------------------------
// The extension asks the server which domains produce only rejections and
// stops capturing them at the source. A single keep permanently protects a
// domain — reddit-style sites stay live as long as any on-focus page appears.

type FilterStats = Record<string, { rejected: number; kept: number }>;

function getFilterStats(): FilterStats {
  const raw = store.getSetting('filter_stats');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FilterStats;
  } catch {
    return {};
  }
}

function saveFilterStats(stats: FilterStats): void {
  store.setSetting('filter_stats', JSON.stringify(stats));
}

function clearFilterStats(): void {
  store.setSetting('filter_stats', '{}');
}

function noteFilter(domain: string, kept: boolean): void {
  const stats = getFilterStats();
  const entry = stats[domain] ?? { rejected: 0, kept: 0 };
  if (kept) entry.kept++;
  else entry.rejected++;
  stats[domain] = entry;
  saveFilterStats(stats);
}

function filterList(): string[] {
  // Bar deliberately high (10, zero keeps): one keep permanently protects a
  // domain, so only dead-cold domains land on the extension ignore list.
  return Object.entries(getFilterStats())
    .filter(([, v]) => v.rejected >= 10 && v.kept === 0)
    .map(([domain]) => domain);
}

// --- token ---------------------------------------------------------------------

function loadOrCreateToken(): string {
  // Empty file must regenerate: '' compares equal to itself in
  // timingSafeEqual, which would disable auth entirely.
  const existing = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, 'utf8').trim() : '';
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
  return token;
}

const token = loadOrCreateToken();

const app = new Hono();

// DNS rebinding guard: a remote page that rebinds its DNS to 127.0.0.1 arrives
// with Host: evil.com (same-origin, so it could read responses). Only loopback
// hostnames get in, which kills that whole class. Also stamps hardening headers
// on every response.
app.use('*', async (c, next) => {
  const host = (c.req.header('host') ?? '').toLowerCase();
  const name = host.lastIndexOf(':') > host.lastIndexOf(']') ? host.slice(0, host.lastIndexOf(':')) : host;
  if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]') {
    return c.json({ error: 'forbidden host' }, 403);
  }
  await next();
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('x-frame-options', 'deny');
});

// --- open routes (before auth): static feed + health + bootstrap ----------------

app.get('/health', (c) => c.json({ ok: true, version: '0.3.0' }));

// Pre-wiring for the extension: hands out the local token without manual paste.
// No CORS headers + the Host allowlist above mean web pages cannot read
// responses; only the extension (host_permissions) and same-machine processes
// can reach it.
app.get('/bootstrap', (c) => c.json({ token }));

const staticFiles: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/rules': { file: 'rules.html', type: 'text/html; charset=utf-8' },
  '/updates.xml': { file: 'updates.xml', type: 'application/xml' },
  '/recall.crx': { file: 'recall.crx', type: 'application/x-chrome-extension' },
};

for (const [route, spec] of Object.entries(staticFiles)) {
  app.get(route, (c) => {
    const full = path.join(PUBLIC_DIR, spec.file);
    if (!existsSync(full)) return c.text('not found: ' + spec.file, 404);
    if (route !== '/') console.log(`ext feed: ${route} fetched`); // reinstall debugging
    return c.body(readFileSync(full), 200, { 'content-type': spec.type });
  });
}

// --- authenticated routes --------------------------------------------------------

app.use('*', async (c: Context, next: Next) => {
  if (c.req.path === '/health') return next();
  const provided = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const match =
    provided.length === token.length && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
  if (!match) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.post('/ingest', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (body === null || typeof body !== 'object') return c.json({ error: 'invalid json' }, 400);
  const obj = body as { pages?: unknown };
  const arr = (Array.isArray(obj.pages) ? obj.pages : Array.isArray(body) ? body : [body]) as PageInput[];
  if (arr.length === 0 || arr.length > 200) return c.json({ error: 'batch size 1-200' }, 413);

  // Recording gate at the sink: pause must stop captures even if a client
  // missed the flag sync. Pages read BEFORE the pause still land (they were
  // legitimately visited); anything captured after it is dropped.
  const offAt = getRecordingOffAt();
  let pages = arr;
  let dropped = 0;
  if (offAt > 0) {
    const nowMs = Date.now();
    pages = arr.filter((p) => {
      const at =
        p && typeof p === 'object' && typeof (p as PageInput).capturedAt === 'number'
          ? ((p as PageInput).capturedAt as number)
          : nowMs;
      return at <= offAt;
    });
    dropped = arr.length - pages.length;
  }

  // Early gate: keyword hit → keep immediately (rule keywords are the user's
  // own condensed signal). Otherwise Julia-1 keep/drop BEFORE any embedding
  // work; no enabled rules = remember everything (gate off).
  const enabledRules = store.listFocusRules().filter((r) => r.enabled);
  const filteredPages: { url: string; domain: string }[] = [];
  let filtered = 0;
  if (enabledRules.length > 0 && pages.length > 0) {
    const candidateIdx: number[] = [];
    pages.forEach((p, i) => {
      let domain = 'unknown';
      try {
        domain = new URL(String(p.url ?? '')).hostname;
      } catch {
        // keep 'unknown'
      }
      const title = typeof p.title === 'string' ? p.title : null;
      const content = typeof p.content === 'string' ? p.content : '';
      if (store.keywordHit(domain, title, content)) {
        noteFilter(domain, true);
      } else {
        candidateIdx.push(i);
      }
    });
    if (candidateIdx.length > 0) {
      const verdicts = await earlyFilter(
        candidateIdx.map((i) => ({
          title: typeof pages[i]!.title === 'string' ? (pages[i]!.title as string) : null,
          content: typeof pages[i]!.content === 'string' ? (pages[i]!.content as string) : '',
        }))
      );
      if (verdicts) {
        const kept: PageInput[] = [];
        let rescues = 0;
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i]!;
          const vi = candidateIdx.indexOf(i);
          if (vi === -1) {
            kept.push(p);
            continue;
          }
          let domain = 'unknown';
          try {
            domain = new URL(String(p.url ?? '')).hostname;
          } catch {
            // keep 'unknown'
          }
          if (verdicts[vi]) {
            kept.push(p);
            noteFilter(domain, true);
          } else if (rescues < 5) {
            // Julia dropped it, but give the full verdict (taught exemplars +
            // rule semantics) a chance — e.g. list/catalog pages the classifier
            // reads as noise while the embedding scores them on-topic. Capped
            // by ATTEMPTS (not successes) per batch: unbounded synchronous
            // embedding inside the request is what pegged the server during
            // the 2026-11-25 retry storm.
            rescues++;
            if (
              await store.focusCheck(
                typeof p.title === 'string' ? (p.title as string) : null,
                domain,
                typeof p.content === 'string' ? (p.content as string) : ''
              )
            ) {
              kept.push(p);
              noteFilter(domain, true);
            } else {
              filtered++;
              filteredPages.push({ url: String(p.url ?? ''), domain });
              noteFilter(domain, false);
            }
          } else {
            filtered++;
            filteredPages.push({ url: String(p.url ?? ''), domain });
            noteFilter(domain, false);
          }
        }
        pages = kept;
      }
    }
  }

  if (pages.length === 0) {
    return c.json({ inserted: 0, skipped: 0, dropped, filtered, filteredPages });
  }
  return c.json({ ...store.ingest(pages), dropped, filtered, filteredPages });
});

// Machine-client params: NaN would bind as NULL (silent empty) or throw
// downstream. Validate at the edge, 400 instead.
function finiteParam(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return null as unknown as number;
  return n;
}

app.get('/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const domain = c.req.query('domain') || undefined;
  const since = finiteParam(c.req.query('since'));
  const until = finiteParam(c.req.query('until'));
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
  if (since === null || until === null || !Number.isFinite(limit)) {
    return c.json({ error: 'since/until/limit must be numbers' }, 400);
  }
  const mode = c.req.query('mode') === 'keyword' ? 'keyword' : 'hybrid';
  const hits = await store.search({ q, domain, since, until, limit, mode });
  return c.json({ hits });
});

app.get('/recent', (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const since = finiteParam(c.req.query('since'));
  if (since === null) return c.json({ error: 'since must be a number' }, 400);
  const rows = store.recent(limit, since);
  return c.json({ pages: rows });
});

app.get('/stats', (c) => c.json(store.stats()));

// --- data management (review + delete) -------------------------------------------

app.get('/pages/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  const page = store.getPage(id);
  if (!page) return c.json({ error: 'not found' }, 404);
  return c.json(page);
});

app.delete('/pages/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  return c.json({ deleted: store.deletePage(id) });
});

app.delete('/pages', (c) => {
  const domain = c.req.query('domain');
  const olderThanDays = finiteParam(c.req.query('olderThanDays'));
  if (olderThanDays === null) return c.json({ error: 'olderThanDays must be a number' }, 400);
  if (!domain && olderThanDays === undefined) return c.json({ error: 'domain or olderThanDays required' }, 400);
  return c.json({ deleted: store.deletePages({ domain, olderThanDays }) });
});

app.get('/settings', (c) => c.json({ retentionDays: store.getRetention() }));

app.post('/settings', async (c) => {
  const body = await c.req.json<{ retentionDays?: unknown }>().catch(() => null);
  if (!body || typeof body.retentionDays !== 'number' || body.retentionDays < 0 || body.retentionDays > 3650) {
    return c.json({ error: 'retentionDays: 0-3650 (0 = forever)' }, 400);
  }
  store.setRetention(body.retentionDays);
  return c.json({ retentionDays: store.getRetention() });
});

// --- recording flag (single source of truth: tray/dashboard/extension follow it)

function getRecording(): boolean {
  return store.getSetting('recording') !== '0'; // default on
}

// Timestamp of the last pause — the ingest gate compares page capturedAt
// against it, so buffered pre-pause pages survive and post-pause ones drop.
function getRecordingOffAt(): number {
  return Number(store.getSetting('recording_off_at')) || 0;
}

function setRecording(on: boolean): void {
  store.setSetting('recording', on ? '1' : '0');
  store.setSetting('recording_off_at', on ? '' : String(Date.now()));
}

app.get('/config', (c) => c.json({ recording: getRecording() }));

app.post('/config', async (c) => {
  const body = await c.req.json<{ recording?: unknown }>().catch(() => null);
  if (!body || typeof body.recording !== 'boolean') return c.json({ error: 'recording: boolean' }, 400);
  setRecording(body.recording);
  return c.json({ recording: getRecording() });
});

// --- focus rules API under /api/*; /rules serves the UI ---------------------------

app.get('/api/rules', (c) => c.json({ rules: store.listFocusRules(), pruned: store.focusPruned() }));

app.post('/api/rules', async (c) => {
  const body = await c.req
    .json<{ enabled?: unknown; domain?: unknown; topics?: unknown; keywords?: unknown; threshold?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'invalid json' }, 400);
  const domain =
    typeof body.domain === 'string' && body.domain.trim() !== '' ? body.domain.trim().toLowerCase() : null;
  let id: number;
  try {
    id = await store.setFocusRule({ ...body, domain, enabled: body.enabled === false ? false : undefined });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'rule rejected' }, 400);
  }
  const pruned = await store.sweepFocusRules();
  refreshCriteria();
  clearFilterStats(); // new criteria — auto-ignore memory starts fresh
  return c.json({ id, pruned });
});

app.patch('/api/rules/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'enabled: boolean' }, 400);
  const changed = store.setRuleEnabled(id, body.enabled);
  if (!changed) return c.json({ error: 'not found' }, 404);
  const pruned = body.enabled ? await store.sweepFocusRules() : 0;
  refreshCriteria();
  clearFilterStats();
  return c.json({ enabled: body.enabled, pruned });
});

app.delete('/api/rules/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  const deleted = store.deleteFocusRule(id);
  if (deleted) {
    refreshCriteria();
    clearFilterStats();
  }
  return c.json({ deleted });
});

app.post('/api/rules/preview', async (c) => {
  const body = await c.req
    .json<{ domain?: unknown; topics?: unknown; keywords?: unknown; threshold?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: 'invalid json' }, 400);
  const domain =
    typeof body.domain === 'string' && body.domain.trim() !== '' ? body.domain.trim().toLowerCase() : null;
  try {
    return c.json(await store.previewFocusRule({ ...body, domain }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'preview failed' }, 400);
  }
});

// --- early-filter feedback list ---------------------------------------------------

app.get('/api/filterlist', (c) => c.json({ domains: filterList(), stats: getFilterStats() }));

app.delete('/api/filterlist', (c) => {
  clearFilterStats();
  return c.json({ reset: true });
});

// --- exemplars: pages the user taught ("keep pages like this") ---------------------

app.get('/api/exemplars', (c) => c.json({ exemplars: store.listExemplars() }));

// Teach from raw page material (popup re-extract, MCP tool).
app.post('/api/exemplars', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid json' }, 400);
  try {
    return c.json({ exemplar: await store.addExemplar(body as Record<string, unknown>) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'teach failed' }, 400);
  }
});

// Teach from an already-captured page.
app.post('/api/exemplars/from/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  const page = store.getPage(id);
  if (!page) return c.json({ error: 'not found' }, 404);
  try {
    return c.json({ exemplar: await store.addExemplar({ url: page.url, title: page.title, content: page.content }) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'teach failed' }, 400);
  }
});

app.delete('/api/exemplars/:id', (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad id' }, 400);
  return c.json({ deleted: store.deleteExemplar(id) === 1 });
});

// --- user blocklist (canonical: popup, dashboard and extension share it) ---------

// Accepts "example.com", "https://www.example.com/page" — anything that reduces
// to a registrable-looking host. Subdomain matching happens at capture time
// (hostMatches), so the stored form is the bare host.
function normalizeDomain(v: string): string | null {
  let s = v.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split(':')[0]!;
  return /^[a-z0-9.-]+\.[a-z]+$/.test(s) ? s : null;
}

function getBlocked(): string[] {
  const raw = store.getSetting('blocked_domains');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of arr) {
      if (typeof d !== 'string') continue;
      const norm = normalizeDomain(d);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function blockedWithCounts(): { domain: string; pages: number }[] {
  const domains = getBlocked();
  const counts = store.domainCounts(domains);
  return domains.map((domain) => ({ domain, pages: counts[domain] ?? 0 }));
}

app.get('/api/blocked', (c) => c.json({ domains: blockedWithCounts() }));

app.put('/api/blocked', async (c) => {
  const body = await c.req.json<{ domains?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.domains) || body.domains.some((d) => typeof d !== 'string')) {
    return c.json({ error: 'domains: string[]' }, 400);
  }
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const d of body.domains as string[]) {
    const norm = normalizeDomain(d);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      domains.push(norm);
    }
  }
  store.setSetting('blocked_domains', JSON.stringify(domains));
  return c.json({ domains: blockedWithCounts() });
});

// --- extension reinstall ----------------------------------------------------------
// Chrome force-installs the extension via a machine-level policy pointing at
// updates.xml on this server. Removing the extension in Chrome sticks only when
// that policy is gone; reinstall = repack CRX + rewrite policy + restart Chrome.

const PROJECT_ROOT = path.join(root, '..');
const CHROME_POLICY = '/Library/Preferences/com.google.Chrome';
const UPDATE_URL = `http://127.0.0.1:${PORT}/updates.xml`;

function extId(): string | null {
  const file = path.join(PUBLIC_DIR, 'updates.xml');
  const xml = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return /\bappid="([a-p]{32})"/.exec(xml)?.[1] ?? null;
}

// Unprivileged read works; missing key/domain = empty list.
function policyEntries(): string[] {
  const res = spawnSync('defaults', ['read', CHROME_POLICY, 'ExtensionInstallForcelist'], { encoding: 'utf8' });
  if (res.status !== 0) return [];
  return (res.stdout.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
}

function extStatus() {
  const id = extId();
  return {
    extId: id,
    crx: existsSync(path.join(PUBLIC_DIR, 'recall.crx')),
    policyInstalled: id !== null && policyEntries().includes(`${id};${UPDATE_URL}`),
    extPath: path.join(PROJECT_ROOT, 'extension'),
  };
}

function writePolicyCommand(entries: string[]): string {
  return `defaults write ${CHROME_POLICY} ExtensionInstallForcelist -array ${entries.map((e) => `'${e}'`).join(' ')}`;
}

app.get('/api/extension', (c) => c.json(extStatus()));

app.post('/api/extension/reinstall', (c) => {
  // 1. rebuild bundle + repack CRX (pinned key keeps the extension ID stable).
  // Blocking spawnSync: single-user local server, callers just wait.
  for (const script of ['extension/build.mjs', 'scripts/pack-extension.mjs']) {
    const res = spawnSync(process.execPath, [path.join(PROJECT_ROOT, script)], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    if (res.status !== 0) return c.json({ error: `${script} failed: ${(res.stderr || res.stdout).slice(-300)}` }, 500);
  }
  const id = extId();
  if (id === null) return c.json({ error: 'pack produced no updates.xml' }, 500);
  // 2. merge + rewrite the force-install policy — only when actually missing,
  // so a healthy setup doesn't get a surprise admin-password prompt. Chrome
  // ≥137 honors this policy only on MDM/enterprise-managed browsers, so the
  // message steers unmanaged setups to Load unpacked.
  const all = policyEntries();
  let sudoCommand: string | undefined;
  let policyNote: string;
  if (all.includes(`${id};${UPDATE_URL}`)) {
    policyNote = 'force-install policy already present';
  } else {
    const entries = all.filter((e) => e.split(';')[0] !== id);
    entries.push(`${id};${UPDATE_URL}`);
    const cmd = writePolicyCommand(entries);
    const osa = spawnSync('osascript', ['-e', `do shell script "${cmd}" with administrator privileges`], { encoding: 'utf8' });
    if (osa.status === 0) {
      policyNote = 'force-install policy written';
    } else {
      policyNote = 'force-install policy write needs admin';
      sudoCommand = `sudo ${cmd}`;
    }
  }
  return c.json({
    ...extStatus(),
    reinstalled: true,
    sudoCommand,
    message: `${policyNote}. Chrome ≥137 skips off-store force-install on unmanaged browsers — if the extension is missing, load unpacked: chrome://extensions → Developer mode → Load unpacked → ${path.join(PROJECT_ROOT, 'extension')}`,
  });
});

// --- hourly: retention purge + focus sweep + embedding self-heal -------------------

setInterval(() => {
  const purged = store.purgeExpired();
  if (purged > 0) console.log(`retention purge: ${purged} pages removed`);
  void store.sweepFocusRules().then((pruned) => {
    if (pruned > 0) console.log(`focus sweep: ${pruned} pages pruned`);
  });
  void store.backfillEmbeddings().then((n) => {
    if (n > 0) console.log(`embedding backfill: ${n} pages queued`);
  });
}, 60 * 60 * 1000).unref();

mkdirSync(path.dirname(DB_PATH), { recursive: true });
void store.backfillEmbeddings();

const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`recall server on http://127.0.0.1:${info.port} (db: ${DB_PATH})`);
  console.log('status page: http://127.0.0.1:8787/');
  const ext = extStatus();
  if (!ext.crx || !ext.policyInstalled) {
    console.log(
      `extension not force-installed (crx ${ext.crx ? 'ok' : 'missing'}, policy ${ext.policyInstalled ? 'ok' : 'missing'}) — Chrome ≥137 honors the policy only on MDM-managed browsers; else load unpacked from ${ext.extPath}`
    );
  }
});
server.on('error', (err) => {
  console.error('server error:', err instanceof Error ? err.message : err);
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error('port 8787 already in use — stopping (not crash-looping)');
    process.exit(1);
  }
});
