import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { EMBED_DIM, EMBED_MODEL, embedOne } from './embeddings.js';
export { EMBED_DIM, EMBED_MODEL };
export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface PageInput {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  excerpt?: unknown;
  byline?: unknown;
  dwellMs?: unknown;
  capturedAt?: unknown;
}

export interface SearchParams {
  q: string;
  domain?: string;
  since?: number;
  until?: number;
  limit?: number;
  mode?: 'keyword' | 'hybrid';
}

export interface SearchHit {
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

export interface Stats {
  pages: number;
  domains: number;
  dbBytes: number;
  embedded: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  excerpt TEXT,
  byline TEXT,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  captured_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  url_day_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
CREATE INDEX IF NOT EXISTS idx_pages_captured_at ON pages(captured_at);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, content, content='pages', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TABLE IF NOT EXISTS page_vectors (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS focus_rules (
  id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  domain TEXT,
  topics TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  threshold REAL NOT NULL DEFAULT 0.35,
  topic_vecs BLOB,
  n_topics INTEGER NOT NULL DEFAULT 0
);
`;

// A focus rule tells recall what to remember: pages in scope (domain, or
// everywhere when null) are kept if their content is semantically close to any
// topic description (cosine >= threshold, via the same MiniLM embeddings used
// for search) OR mentions any keyword verbatim. Everything else in scope is
// pruned. Topics beat keywords: "AI" in a book review won't match a topic
// about machine learning the way a real embedding match will.
export interface FocusRule {
  id: number;
  enabled: boolean;
  domain: string | null; // null = all domains
  topics: string[];
  keywords: string[];
  threshold: number;
  hasVectors: boolean; // topic vectors embedded and stored
}

const MAX_CONTENT_BYTES = 2_000_000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalize(input: PageInput):
  | {
      url: string;
      domain: string;
      title: string | null;
      content: string;
      excerpt: string | null;
      byline: string | null;
      dwellMs: number;
      capturedAt: number;
    }
  | null {
  if (typeof input.url !== 'string' || typeof input.content !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (input.content.length === 0 || Buffer.byteLength(input.content) > MAX_CONTENT_BYTES) return null;
  const title = typeof input.title === 'string' ? input.title.slice(0, 512) : null;
  const excerpt = typeof input.excerpt === 'string' ? input.excerpt.slice(0, 512) : null;
  const byline = typeof input.byline === 'string' ? input.byline.slice(0, 256) : null;
  const dwellMs =
    typeof input.dwellMs === 'number' && Number.isFinite(input.dwellMs) && input.dwellMs > 0
      ? Math.round(input.dwellMs)
      : 0;
  const capturedAt =
    typeof input.capturedAt === 'number' && Number.isFinite(input.capturedAt)
      ? Math.round(input.capturedAt)
      : Date.now();
  return {
    url: input.url,
    domain: parsed.hostname,
    title,
    content: input.content,
    excerpt,
    byline,
    dwellMs,
    capturedAt,
  };
}

// Quote user query tokens so FTS operators in raw input can't break syntax.
function ftsQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .filter((t) => t !== '""')
    .join(' ');
}

export function createStore(dbPath: string, embedText: EmbedFn = embedOne) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  sqliteVec.load(db);
  db.exec(SCHEMA);

  // Embedder switch: vectors from a different model are incompatible — drop
  // them once; startup backfill + focus sweeps re-embed lazily.
  {
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('embed_model') as
      | { value: string }
      | undefined;
    if (stored && stored.value !== EMBED_MODEL) {
      db.exec('DELETE FROM page_vectors');
      db.prepare('UPDATE focus_rules SET topic_vecs = NULL, n_topics = 0').run();
      console.log(`embedder changed (${stored.value} -> ${EMBED_MODEL}) — vectors wiped for re-embed`);
    }
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run('embed_model', EMBED_MODEL);
  }

  const exists = db.prepare('SELECT 1 AS x FROM pages WHERE url = ? AND content_hash = ? LIMIT 1');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pages (url, domain, title, content, excerpt, byline, dwell_ms, captured_at, content_hash, url_day_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Dedup: same URL + same content never stored twice. Content change or new
  // URL inserts a new row; url_day_hash unique index is the same-day race backstop.
  function ingest(inputs: PageInput[]): { inserted: number; skipped: number } {
    let inserted = 0;
    let skipped = 0;
    db.transaction((items: PageInput[]) => {
      for (const raw of items) {
        const page = normalize(raw);
        if (!page) {
          skipped++;
          continue;
        }
        const contentHash = sha256(page.content);
        if (exists.get(page.url, contentHash)) {
          skipped++;
          continue;
        }
        const day = new Date(page.capturedAt).toISOString().slice(0, 10);
        const res = insert.run(
          page.url,
          page.domain,
          page.title,
          page.content,
          page.excerpt,
          page.byline,
          page.dwellMs,
          page.capturedAt,
          contentHash,
          sha256(`${page.url}|${contentHash}|${day}`)
        );
        if (res.changes === 0) skipped++;
        else {
          inserted++;
          queueEmbedding(Number(res.lastInsertRowid), page.content, page.title, page.domain);
        }
      }
    })(inputs);
    return { inserted, skipped };
  }

  // --- temporal annotation + ranking -----------------------------------------

  const newerStmt = db.prepare(
    'SELECT id AS newerId FROM pages WHERE url = ? AND captured_at > ? ORDER BY captured_at DESC LIMIT 1'
  );

  // Adds ageDays, supersededBy (newer capture of same URL exists) and stale
  // flag; multiplies rank by time decay (~30d half-life). Higher rank = more
  // relevant, consistent across keyword and hybrid modes.
  function annotate(rows: {
    id: number;
    url: string;
    domain: string;
    title: string | null;
    snippet: string;
    capturedAt: number;
    dwellMs: number;
    rank: number;
  }[]): SearchHit[] {
    const now = Date.now();
    const DAY = 86_400_000;
    const out = rows.map((row) => {
      const ageDays = Math.max(0, (now - row.capturedAt) / DAY);
      const newer = newerStmt.get(row.url, row.capturedAt) as { newerId?: number } | undefined;
      const supersededBy = newer?.newerId ?? null;
      const decay = 1 / (1 + ageDays / 30);
      return {
        ...row,
        rank: row.rank * decay,
        ageDays: Math.round(ageDays * 10) / 10,
        supersededBy,
        stale: supersededBy !== null || ageDays > 90,
      };
    });
    return out.sort((a, b) => b.rank - a.rank);
  }

  // --- vector index -----------------------------------------------------------

  const insertVec = db.prepare('INSERT OR REPLACE INTO page_vectors(page_id, embedding) VALUES (?, ?)');
  const MAX_PENDING_EMBEDS = 5000;
  const pendingEmbed: { id: number; content: string; title: string | null; domain: string; attempts: number }[] = [];
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();

  function toBlob(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }

  function queueEmbedding(id: number, content: string, title: string | null, domain: string): void {
    // Bounded: on overflow drop oldest — backfillEmbeddings re-queues rows
    // still missing from page_vectors, so nothing is lost permanently.
    if (pendingEmbed.length >= MAX_PENDING_EMBEDS) pendingEmbed.shift();
    pendingEmbed.push({ id, content, title, domain, attempts: 0 });
    void drainEmbeddings();
  }

  function drainEmbeddings(): Promise<void> {
    if (!draining) {
      draining = true;
      drainPromise = (async () => {
        try {
          while (pendingEmbed.length > 0) {
            const job = pendingEmbed[0]!;
            try {
              const vec = await embedText(job.content);
              // Focus gate: with the vector in hand the semantic rule gets its
              // real verdict. Reject = delete the page before it ever joins the
              // search index.
              const verdict = focusVerdict(job.title, job.domain, job.content, vec);
              if (!verdict.keep) {
                deleteById.run(job.id);
                focusPrunedCount += verdict.pruned;
                pendingEmbed.shift();
                continue;
              }
              insertVec.run(job.id, toBlob(vec));
              pendingEmbed.shift();
            } catch (err) {
              job.attempts++;
              if (job.attempts >= 3) {
                pendingEmbed.shift();
                console.error(
                  `embed failed 3x, dropping (page ${job.id}):`,
                  err instanceof Error ? err.message : err
                );
              } else {
                // Transient (model load/download): move job to the end, stop
                // draining. Next ingest or hourly backfill retriggers the drain.
                pendingEmbed.push(job);
                pendingEmbed.shift();
                break;
              }
            }
          }
        } finally {
          draining = false;
        }
      })();
    }
    // Await the real in-flight drain even when this call was the no-op guard.
    return drainPromise;
  }

  async function backfillEmbeddings(): Promise<number> {
    const rows = db
      .prepare(
        'SELECT id, content, title, domain FROM pages WHERE id NOT IN (SELECT page_id FROM page_vectors) LIMIT 500'
      )
      .all() as { id: number; content: string; title: string | null; domain: string }[];
    for (const row of rows) queueEmbedding(row.id, row.content, row.title, row.domain);
    return rows.length;
  }

  function searchVec(vec: Float32Array, limit: number): { pageId: number; distance: number }[] {
    // Inline (clamped) LIMIT: better-sqlite3 can't bind LIMIT ? together with
    // the vec_distance_* scalar function's parameter.
    const k = Math.min(Math.max(Math.floor(limit), 1), 500);
    return db
      .prepare(
        `SELECT page_id AS pageId, vec_distance_cosine(embedding, ?) AS distance FROM page_vectors ORDER BY distance LIMIT ${k}`
      )
      .all(toBlob(vec)) as { pageId: number; distance: number }[];
  }

  function keywordSearch(params: SearchParams): SearchHit[] {
    const match = ftsQuery(params.q);
    if (!match) return [];
    const conds = ['pages_fts MATCH ?'];
    const args: (string | number)[] = [match];
    if (params.domain) {
      conds.push('p.domain = ?');
      args.push(params.domain);
    }
    if (params.since !== undefined) {
      conds.push('p.captured_at >= ?');
      args.push(params.since);
    }
    if (params.until !== undefined) {
      conds.push('p.captured_at <= ?');
      args.push(params.until);
    }
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    args.push(limit);
    const rows = db
      .prepare(
        `SELECT p.id AS id, p.url AS url, p.domain AS domain, p.title AS title,
                snippet(pages_fts, 1, '[', ']', '…', 16) AS snippet,
                p.captured_at AS capturedAt, p.dwell_ms AS dwellMs,
                1/(1+abs(bm25(pages_fts))) AS rank
         FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE ${conds.join(' AND ')}
         LIMIT ?`
      )
      .all(...args) as Omit<SearchHit, 'ageDays' | 'supersededBy' | 'stale'>[];
    return annotate(rows);
  }

  // Hybrid: FTS bm25 + vector KNN merged with reciprocal rank fusion.
  async function search(params: SearchParams): Promise<SearchHit[]> {
    if (params.mode === 'keyword') return keywordSearch(params);
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const fts = keywordSearch({ ...params, limit: limit * 2 });
    let vecRows: { pageId: number; distance: number }[] = [];
    try {
      const queryVec = await embedText(params.q);
      vecRows = searchVec(queryVec, limit * 2);
    } catch (err) {
      // model unavailable or vec query failed: keyword results still returned
      console.error('vector search skipped:', err instanceof Error ? err.message : err);
    }
    const scores = new Map<number, number>();
    fts.forEach((hit, i) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (60 + i + 1)));
    vecRows.forEach((row, i) => scores.set(row.pageId, (scores.get(row.pageId) ?? 0) + 1 / (60 + i + 1)));
    const ids = [...scores.keys()];
    if (ids.length === 0) return [];
    // Same filters as the keyword leg, applied to the merged meta fetch so
    // vector-leg hits can't bypass domain/time constraints.
    const conds = [`p.id IN (${ids.map(() => '?').join(',')})`];
    const args: (string | number)[] = [...ids];
    if (params.domain) {
      conds.push('p.domain = ?');
      args.push(params.domain);
    }
    if (params.since !== undefined) {
      conds.push('p.captured_at >= ?');
      args.push(params.since);
    }
    if (params.until !== undefined) {
      conds.push('p.captured_at <= ?');
      args.push(params.until);
    }
    const meta = db
      .prepare(
        `SELECT p.id AS id, p.url AS url, p.domain AS domain, p.title AS title,
                substr(p.content, 1, 160) AS snippet,
                p.captured_at AS capturedAt, p.dwell_ms AS dwellMs
         FROM pages p WHERE ${conds.join(' AND ')}`
      )
      .all(...args) as Omit<SearchHit, 'rank'>[];
    const rankById = new Map(meta.map((row) => [row.id, row]));
    const merged: SearchHit[] = [];
    for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
      const row = rankById.get(id);
      if (!row) continue;
      const ftsHit = fts.find((hit) => hit.id === id);
      merged.push({ ...row, snippet: ftsHit?.snippet ?? row.snippet, rank: score });
    }
    return annotate(merged).slice(0, limit);
  }

  function stats(): Stats {
    const row = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM pages) AS pages,
                (SELECT COUNT(DISTINCT domain) FROM pages) AS domains,
                (SELECT COUNT(*) FROM page_vectors) AS embedded`
      )
      .get() as { pages: number; domains: number; embedded: number };
    const dbBytes =
      (db.pragma('page_count', { simple: true }) as number) *
      (db.pragma('page_size', { simple: true }) as number);
    return { ...row, dbBytes };
  }

  function recent(limit: number, since?: number): SearchHit[] {
    const rows = db
      .prepare(
        `SELECT p.id, p.url, p.domain, p.title, p.captured_at AS capturedAt, p.dwell_ms AS dwellMs
         FROM pages p ${since !== undefined ? 'WHERE p.captured_at >= ?' : ''}
         ORDER BY p.captured_at DESC LIMIT ?`
      )
      .all(...(since !== undefined ? [since, limit] : [limit])) as Omit<
      SearchHit,
      'rank' | 'snippet' | 'ageDays' | 'supersededBy' | 'stale'
    >[];
    // Annotated (ageDays/supersededBy/stale) so MCP + dashboard see the same
    // temporal view as search; snippet/rank are meaningless here.
    return annotate(rows.map((r) => ({ ...r, snippet: '', rank: 0 })));
  }

  function getPage(id: number):
    | (Omit<SearchHit, 'rank' | 'snippet' | 'ageDays' | 'supersededBy' | 'stale'> & {
        content: string;
        excerpt: string | null;
        byline: string | null;
      })
    | null {
    const row = db
      .prepare(
        `SELECT p.id, p.url, p.domain, p.title, p.content, p.excerpt, p.byline,
                p.captured_at AS capturedAt, p.dwell_ms AS dwellMs
         FROM pages p WHERE p.id = ?`
      )
      .get(id) as { id: number; url: string; domain: string; title: string | null; content: string; excerpt: string | null; byline: string | null; capturedAt: number; dwellMs: number } | undefined;
    return row ?? null;
  }

  // --- deletes + retention -----------------------------------------------------

  const deleteById = db.prepare('DELETE FROM pages WHERE id = ?');
  const deleteByDomain = db.prepare('DELETE FROM pages WHERE domain = ?');
  const deleteOlderThan = db.prepare('DELETE FROM pages WHERE captured_at < ?');

  function deletePage(id: number): number {
    return deleteById.run(id).changes;
  }

  function deletePages(opts: { domain?: string; olderThanDays?: number }): number {
    if (opts.domain) return deleteByDomain.run(opts.domain).changes;
    if (opts.olderThanDays !== undefined) {
      return deleteOlderThan.run(Date.now() - opts.olderThanDays * 86_400_000).changes;
    }
    return 0;
  }

  // Per-domain stored-page counts, for the blocklist UI ("also delete N pages").
  function domainCounts(domains: string[]): Record<string, number> {
    const stmt = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE domain = ?');
    const out: Record<string, number> = {};
    for (const d of domains) out[d] = (stmt.get(d) as { n: number }).n;
    return out;
  }

  function getSetting(key: string): string | null {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  function setSetting(key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)').run(key, value);
  }

  function getRetention(): number {
    const days = getSetting('retentionDays');
    return days === null ? 0 : Number(days); // 0 = keep forever
  }

  function setRetention(days: number): void {
    setSetting('retentionDays', String(Math.max(0, Math.floor(days))));
  }

  function purgeExpired(): number {
    const days = getRetention();
    if (days <= 0) return 0;
    return deleteOlderThan.run(Date.now() - days * 86_400_000).changes;
  }

  // --- focus rules (semantic auto-prune) --------------------------------------
  // Rule = {enabled, domain (null = all sites), topics[], keywords[], threshold}.
  // A page in scope is KEPT if any keyword appears verbatim OR its embedding is
  // cosine-close (>= threshold) to any topic embedding — same MiniLM vectors
  // search uses. Verdicts happen where embeddings exist: in the embed drain for
  // new pages, in sweeps for stored rows. Undecided pages (no vector yet) are
  // never deleted — they wait for evidence.
  let focusPrunedCount = 0;

  function domainInScope(pageDomain: string, ruleDomain: string | null): boolean {
    return ruleDomain === null || pageDomain === ruleDomain || pageDomain.endsWith('.' + ruleDomain);
  }

  // Word-boundary match: "rag" must hit "rag pipeline", not the "rag" inside
  // "storage" (2026-11-25: every "storage"-bearing page was keyword-kept).
  function hasKeyword(title: string | null, content: string, keywords: string[]): boolean {
    if (keywords.length === 0) return false;
    const hay = ((title ?? '') + '\n' + content).toLowerCase();
    return keywords.some((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay));
  }

  function blobToVecs(blob: Buffer | null, n: number): Float32Array[] {
    if (!blob || n === 0) return [];
    const copy = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
    const out: Float32Array[] = [];
    for (let i = 0; i < n; i++) out.push(copy.slice(i * EMBED_DIM, (i + 1) * EMBED_DIM));
    return out;
  }

  function maxSim(pageVec: Float32Array, topicVecs: Float32Array[]): number {
    // vectors are normalized (embed pipeline) → cosine = dot product
    let best = -1;
    for (const t of topicVecs) {
      let dot = 0;
      for (let i = 0; i < pageVec.length; i++) dot += pageVec[i]! * t[i]!;
      if (dot > best) best = dot;
    }
    return best;
  }

  interface RuleRow {
    id: number;
    enabled: number;
    domain: string | null;
    topics: string;
    keywords: string;
    threshold: number;
    topic_vecs: Buffer | null;
    n_topics: number;
  }

  const focusRuleStmt = db.prepare(
    'SELECT id, enabled, domain, topics, keywords, threshold, topic_vecs, n_topics FROM focus_rules'
  );
  const insertFocusRule = db.prepare(
    `INSERT INTO focus_rules(enabled, domain, topics, keywords, threshold, topic_vecs, n_topics)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updateFocusVecs = db.prepare('UPDATE focus_rules SET topic_vecs = ?, n_topics = ? WHERE id = ?');
  const updateFocusEnabled = db.prepare('UPDATE focus_rules SET enabled = ? WHERE id = ?');
  const deleteFocusRuleStmt = db.prepare('DELETE FROM focus_rules WHERE id = ?');

  function parseRule(r: RuleRow) {
    const topics = r.topics.split('\n').map((s) => s.trim()).filter(Boolean);
    const keywords = r.keywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const topicVecs = blobToVecs(r.topic_vecs, r.n_topics);
    return { id: r.id, enabled: r.enabled === 1, domain: r.domain, threshold: r.threshold, topics, keywords, topicVecs };
  }

  function listFocusRules(): FocusRule[] {
    return (focusRuleStmt.all() as RuleRow[]).map((r) => {
      const p = parseRule(r);
      return {
        id: p.id,
        enabled: p.enabled,
        domain: p.domain,
        topics: p.topics,
        keywords: p.keywords,
        threshold: p.threshold,
        hasVectors: p.topics.length > 0 && p.topicVecs.length === p.topics.length,
      };
    });
  }

  async function embedTopics(topics: string[]): Promise<{ blob: Buffer; n: number }> {
    const vecs = await Promise.all(topics.map((t) => embedText(t)));
    const flat = new Float32Array(vecs.length * EMBED_DIM);
    vecs.forEach((v, i) => flat.set(v, i * EMBED_DIM));
    return { blob: Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength), n: vecs.length };
  }

  function normalizeRuleInput(input: { topics?: unknown; keywords?: unknown; threshold?: unknown }): {
    topics: string[];
    keywords: string[];
    threshold: number;
  } {
    const rawTopics = Array.isArray(input.topics)
      ? input.topics
      : typeof input.topics === 'string'
        ? input.topics.split('\n')
        : [];
    const topics = rawTopics.map((t) => String(t).trim()).filter(Boolean);
    const rawKw = Array.isArray(input.keywords)
      ? input.keywords
      : typeof input.keywords === 'string'
        ? input.keywords.split(',')
        : [];
    const keywords = rawKw.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    const threshold =
      typeof input.threshold === 'number' && Number.isFinite(input.threshold)
        ? Math.min(Math.max(input.threshold, 0.05), 0.9)
        : 0.35;
    if (topics.length === 0) throw new Error('rule needs at least one topic description');
    return { topics, keywords, threshold };
  }

  async function setFocusRule(input: {
    enabled?: boolean;
    domain?: string | null;
    topics?: unknown;
    keywords?: unknown;
    threshold?: unknown;
  }): Promise<number> {
    const { topics, keywords, threshold } = normalizeRuleInput(input);
    let vecs: { blob: Buffer; n: number } | null = null;
    try {
      vecs = await embedTopics(topics);
    } catch {
      // model unavailable: save keyword-only; sweeps embed lazily later
    }
    const res = insertFocusRule.run(
      input.enabled === false ? 0 : 1,
      input.domain ?? null,
      topics.join('\n'),
      keywords.join(','),
      threshold,
      vecs ? vecs.blob : null,
      vecs ? vecs.n : 0
    );
    return Number(res.lastInsertRowid);
  }

  function setRuleEnabled(id: number, enabled: boolean): number {
    return updateFocusEnabled.run(enabled ? 1 : 0, id).changes;
  }

  function deleteFocusRule(id: number): number {
    return deleteFocusRuleStmt.run(id).changes;
  }

  // Aggregate verdict across every enabled rule in scope. KEPT when any rule
  // keeps (keyword hit OR semantic >= threshold). Rules without enough evidence
  // (page not yet embedded, topic vectors missing) abstain — undecided = keep.
  function focusVerdict(
    title: string | null,
    domain: string,
    content: string,
    pageVec: Float32Array | null
  ): { keep: boolean; score: number; pruned: number } {
    const rules = (focusRuleStmt.all() as RuleRow[])
      .map(parseRule)
      .filter((r) => r.enabled && domainInScope(domain, r.domain));
    if (rules.length === 0) return { keep: true, score: 1, pruned: 0 };
    let decided = false;
    let keep = false;
    let best = -1;
    for (const r of rules) {
      if (hasKeyword(title, content, r.keywords)) {
        keep = true;
        decided = true;
        continue;
      }
      if (pageVec && r.topicVecs.length > 0) {
        const s = maxSim(pageVec, r.topicVecs);
        if (s > best) best = s;
        decided = true;
        if (s >= r.threshold) keep = true;
      }
    }
    return { keep: !decided ? true : keep, score: best < 0 ? 1 : best, pruned: decided && !keep ? 1 : 0 };
  }

  async function ensureRuleVecs(rule: ReturnType<typeof parseRule>): Promise<void> {
    if (rule.topics.length > 0 && rule.topicVecs.length === rule.topics.length) return;
    const vecs = await embedTopics(rule.topics);
    updateFocusVecs.run(vecs.blob, vecs.n, rule.id);
    rule.topicVecs = blobToVecs(vecs.blob, vecs.n);
  }

  async function sweepFocusRules(): Promise<number> {
    const rules = (focusRuleStmt.all() as RuleRow[]).map(parseRule).filter((r) => r.enabled);
    for (const r of rules) {
      try {
        await ensureRuleVecs(r);
      } catch {
        // keyword-only mode for this sweep
      }
    }
    const rows = db.prepare('SELECT id, url, title, domain, content FROM pages').all() as {
      id: number;
      url: string;
      title: string | null;
      domain: string;
      content: string;
    }[];
    const vecRows = db.prepare('SELECT page_id, embedding FROM page_vectors').all() as {
      page_id: number;
      embedding: Buffer;
    }[];
    const vecById = new Map(vecRows.map((v) => [v.page_id, v.embedding]));
    let total = 0;
    let embeddedHere = 0;
    for (const row of rows) {
      if (!rules.some((r) => domainInScope(row.domain, r.domain))) continue;
      const blob = vecById.get(row.id);
      let pageVec = blob
        ? new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
        : null;
      // Page not embedded yet (drain hasn't reached it): embed here (bounded)
      // so the sweep can give a real verdict instead of abstaining forever.
      if (!pageVec && embeddedHere < 500) {
        try {
          pageVec = await embedText(row.content);
          embeddedHere++;
        } catch {
          // model down: leave undecided = keep
        }
      }
      const verdict = focusVerdict(row.title, row.domain, row.content, pageVec);
      if (!verdict.keep) {
        deleteById.run(row.id);
        total++;
      }
    }
    return total;
  }

  async function previewFocusRule(input: {
    domain?: string | null;
    topics?: unknown;
    keywords?: unknown;
    threshold?: unknown;
  }): Promise<{
    wouldPrune: number;
    kept: number;
    undecided: number;
    samples: { id: number; url: string; title: string | null; score: number }[];
  }> {
    const { topics, keywords, threshold } = normalizeRuleInput(input);
    let topicVecs: Float32Array[] = [];
    try {
      const v = await embedTopics(topics);
      topicVecs = blobToVecs(v.blob, v.n);
    } catch {
      // keyword-only preview
    }
    const dom = input.domain ?? null;
    const rows = db
      .prepare('SELECT id, url, title, domain, content FROM pages')
      .all() as { id: number; url: string; title: string | null; domain: string; content: string }[];
    const vecRows = db.prepare('SELECT page_id, embedding FROM page_vectors').all() as {
      page_id: number;
      embedding: Buffer;
    }[];
    const vecById = new Map(vecRows.map((v) => [v.page_id, v.embedding]));
    let wouldPrune = 0;
    let kept = 0;
    let undecided = 0;
    const samples: { id: number; url: string; title: string | null; score: number }[] = [];
    const candidates: { row: (typeof rows)[number]; pageVec: Float32Array | null }[] = [];
    for (const row of rows) {
      if (!domainInScope(row.domain, dom)) continue;
      if (hasKeyword(row.title, row.content, keywords)) {
        kept++;
        continue;
      }
      const blob = vecById.get(row.id);
      candidates.push({
        row,
        pageVec: blob
          ? new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
          : null,
      });
    }
    // Embed undecided pages on the fly (bounded) so the preview shows real
    // verdicts, not "undecided" for everything not yet through the drain.
    let embeddedHere = 0;
    const EMBED_CAP = 200;
    for (const c of candidates) {
      let vec = c.pageVec;
      if (!vec && embeddedHere < EMBED_CAP) {
        try {
          vec = await embedText(c.row.content);
          embeddedHere++;
        } catch {
          // model down: undecided
        }
      }
      if (vec && topicVecs.length > 0) {
        const s = maxSim(vec, topicVecs);
        if (s >= threshold) {
          kept++;
        } else {
          wouldPrune++;
          samples.push({ id: c.row.id, url: c.row.url, title: c.row.title, score: Math.round(s * 1000) / 1000 });
        }
      } else {
        undecided++;
      }
    }
    samples.sort((a, b) => a.score - b.score);
    return { wouldPrune, kept, undecided, samples: samples.slice(0, 8) };
  }

  // One-time migration: today's keyword-only prune_rules → focus_rules.
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prune_rules'")
    .get() as { name: string } | undefined;
  if (legacy) {
    const rows = db.prepare('SELECT domain, keywords FROM prune_rules').all() as {
      domain: string;
      keywords: string;
    }[];
    for (const r of rows) {
      insertFocusRule.run(0, r.domain, r.keywords.split(',').join('\n'), r.keywords, 0.35, null, 0);
    }
    db.exec('DROP TABLE prune_rules');
  }

  return {
    ingest,
    search,
    stats,
    recent,
    getPage,
    annotate,
    deletePage,
    deletePages,
    domainCounts,
    getRetention,
    setRetention,
    purgeExpired,
    getSetting,
    setSetting,
    backfillEmbeddings,
    flushEmbeddings: drainEmbeddings,
    setFocusRule,
    listFocusRules,
    setRuleEnabled,
    deleteFocusRule,
    previewFocusRule,
    sweepFocusRules,
    focusPruned: () => focusPrunedCount,
    /** true when any enabled in-scope rule's keyword list hits this page */
    keywordHit: (domain: string, title: string | null, content: string): boolean => {
      const rules = (focusRuleStmt.all() as RuleRow[]).map(parseRule).filter((r) => r.enabled);
      return rules.some((r) => domainInScope(domain, r.domain) && hasKeyword(title, content, r.keywords));
    },
    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof createStore>;
