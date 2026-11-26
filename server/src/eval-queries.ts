// Golden-query eval set: fixture corpus + queries with known right pages,
// run hermetically against the fake embedder (same one as selfcheck). This
// measures the hybrid SEARCH MECHANISM — fusion, filters, temporal decay,
// passage extraction — not granite embedding quality: the fake embedder's
// geometry is token-hash, so "semantic" queries work by sharing domain
// vocabulary with the target by construction. A regression here means the
// search machinery broke, not that the model got worse.
import type { EmbedFn, PageInput } from './store.js';
import { createStore } from './store.js';

const DAY = 86_400_000;

interface EvalQuery {
  note: string;
  q: string;
  expect?: string; // url must appear in top-5
  expectTop?: string; // url must be rank 1
  expectNone?: boolean; // query+filters must return zero hits
  expectTitle?: string; // disambiguate same-url versions (V1/V2)
  expectStale?: boolean; // the expected hit's stale flag must equal this
  mode?: 'keyword' | 'hybrid';
  domain?: string;
  since?: number;
  until?: number;
}

const U = (slug: string) => `https://eval.${slug.replace(/-/g, '')}.test/${slug}`;

// Narrow shape for corpus construction — PageInput fields are `unknown`
// (validation happens in store.normalize), and the token-disjointness guard
// below needs string access.
interface EvalPage {
  url: string;
  title: string;
  content: string;
  capturedAt?: number;
}

function page(slug: string, tokens: string, repeats = 12): EvalPage {
  return { url: U(slug), title: slug, content: `${tokens} `.repeat(repeats) };
}

export function buildCorpus(now: number): PageInput[] {
  const corpus: EvalPage[] = [
    page('sqlite-notes', 'sqlite fts5 bm25 wal checkpoint journal'),
    page('react-hooks', 'react hooks rerender effect memo dependency'),
    page('rust-async', 'rust async await pin future executor'),
    page('sourdough', 'sourdough starter hydration crumb fermentation'),
    page('homelab-dns', 'homelab dns pihole resolver upstream cache'),
    page('mcp-spec', 'mcp protocol stdio tools transport schema'),
    page('vector-notes', 'vectordb embeddings cosine ann recall quantization'),
    page('taichi', 'taichi form balance breath posture'),
    page('bike-fix', 'bicycle derailleur cable index tension'),
    page('coffee-roast', 'coffee roast bean grinder extraction'),
    page('k8s-basics', 'kubernetes pod node scheduler affinity'),
    page('foraging', 'foraging mushrooms forest basket spores'),
    page('telescope', 'telescope collimation mirror focal'),
    page('pgp-keys', 'pgp key sign fingerprint trust web'),
    page('gardening', 'compost soil mulch worms season'),
    page('watercolor', 'watercolor pigment paper wash brush'),
    page('espresso', 'espresso puck pressure dose tamping'),
    page('api-notes', 'api rate limit retry backoff quota'),
    // temporal: same url captured twice — V1 superseded by V2
    {
      url: U('manual'),
      title: 'manual V1',
      content: 'manual widgets calibration alpha procedure. '.repeat(12),
      capturedAt: now - 120 * DAY,
    },
    {
      url: U('manual'),
      title: 'manual V2',
      content: 'manual gadgets calibration beta procedure. '.repeat(12),
    },
    // time-window pair: identical topic, 10d apart
    {
      url: U('changelog-10d'),
      title: 'changelog A',
      content: 'release notes portal update shipped. '.repeat(12),
      capturedAt: now - 10 * DAY,
    },
    {
      url: U('changelog-1d'),
      title: 'changelog B',
      content: 'release notes portal update shipped. '.repeat(12),
    },
    // long essay for passage extraction: three unique sections, far apart
    {
      url: U('long-essay'),
      title: 'long essay',
      content:
        'ALPHA lighthouse keeper storm lantern. ' +
        'filler sentence about shipping schedules. '.repeat(120) +
        'BETA glacier melt survey instruments. ' +
        'filler sentence about shipping schedules. '.repeat(120) +
        'GAMMA origami crane folding precision. '.repeat(6),
    },
  ];
  // Load-bearing fixture property: the 18 single-topic pages must not share
  // tokens, or queries silently lose their sole-match guarantee. (The manual
  // V1/V2 and changelog A/B pairs intentionally overlap; long-essay is
  // self-contained.) Fail loudly on future fixture edits that break this.
  const seen = new Map<string, string>();
  for (const p of corpus.slice(0, 18)) {
    for (const t of new Set(p.content.toLowerCase().split(/\W+/).filter((x) => x.length > 1))) {
      const owner = seen.get(t);
      if (owner !== undefined && owner !== p.url) {
        throw new Error(`eval corpus token '${t}' shared by ${owner} and ${p.url}`);
      }
      seen.set(t, p.url);
    }
  }
  return corpus;
}

const QUERIES: EvalQuery[] = [
  // exact-term: target must be rank 1
  { note: 'exact derailleur', q: 'derailleur', expectTop: U('bike-fix') },
  { note: 'exact collimation', q: 'collimation', expectTop: U('telescope') },
  { note: 'exact fingerprint', q: 'fingerprint', expectTop: U('pgp-keys') },
  { note: 'exact spores', q: 'spores', expectTop: U('foraging') },
  { note: 'exact tamping', q: 'tamping', expectTop: U('espresso') },
  { note: 'exact posture', q: 'posture', expectTop: U('taichi') },
  { note: 'two-term watercolor', q: 'watercolor pigment', expectTop: U('watercolor') },
  { note: 'two-term sourdough', q: 'sourdough hydration', expectTop: U('sourdough') },
  // scattered multi-token: all tokens only co-occur in target — sole lexical
  // match, equal freshness, so rank 1 is deterministic (tightened from top-5
  // per eval review: top-5 passed even with a 2× inverted decay)
  { note: 'scattered sqlite', q: 'sqlite fts5 bm25 wal checkpoint journal', expectTop: U('sqlite-notes') },
  { note: 'scattered react', q: 'react hooks rerender effect memo dependency', expectTop: U('react-hooks') },
  { note: 'scattered rust', q: 'rust async await pin future executor', expectTop: U('rust-async') },
  { note: 'scattered dns', q: 'homelab dns pihole resolver upstream cache', expectTop: U('homelab-dns') },
  { note: 'scattered mcp', q: 'mcp protocol stdio tools transport schema', expectTop: U('mcp-spec') },
  { note: 'scattered vector', q: 'vectordb embeddings cosine ann recall quantization', expectTop: U('vector-notes') },
  { note: 'scattered k8s', q: 'kubernetes pod node scheduler affinity', expectTop: U('k8s-basics') },
  { note: 'scattered api', q: 'api rate limit retry backoff quota', expectTop: U('api-notes') },
  // fusion discrimination: NO page contains all three tokens, so the FTS leg
  // (implicit AND) returns zero rows and the vector KNN must carry the query
  // — fails if searchVec dies into the keyword fallback or fusion drops a leg
  { note: 'fusion vec-only rescue', q: 'derailleur cable espresso', expectTop: U('bike-fix') },
  // fusion discrimination mirror: both tokens in V1, only 'calibration' in V2
  // — lexical overlap favors V1, time decay must hand rank 1 to fresh V2
  { note: 'decay beats lexical', q: 'widgets calibration', expectTop: U('manual'), expectTitle: 'manual V2', expectStale: false },
  // keyword vs hybrid parity: same target rank 1 in both modes
  { note: 'parity keyword', q: 'compost mulch worms', mode: 'keyword', expectTop: U('gardening') },
  { note: 'parity hybrid', q: 'compost mulch worms', mode: 'hybrid', expectTop: U('gardening') },
  { note: 'parity keyword 2', q: 'grinder extraction', mode: 'keyword', expectTop: U('coffee-roast') },
  { note: 'parity hybrid 2', q: 'grinder extraction', mode: 'hybrid', expectTop: U('coffee-roast') },
  // temporal: superseded V1 flagged stale — keyword mode, since FTS matches
  // V1 exclusively ('widgets' only in V1) while hybrid's time decay rightly
  // buries a 120d-old capture under fresh pages
  { note: 'superseded V1 stale', q: 'widgets calibration', mode: 'keyword', expectTop: U('manual'), expectStale: true },
  { note: 'superseded V2 top', q: 'gadgets calibration', expectTop: U('manual'), expectStale: false },
  // window/domain queries need `now` — see dynamicQueries
];

// time-window + domain-filter cases; built at runtime for epoch math.
// expectTop (not top-5) so dropping the WHERE cond fails: unfiltered, the
// fresher sibling takes rank 1. Negative companions catch the meta conds
// being dropped on the vector leg (hits that should not exist at all).
function dynamicQueries(now: number): EvalQuery[] {
  return [
    { note: 'window until -5d', q: 'release notes', until: now - 5 * DAY, expectTop: U('changelog-10d') },
    { note: 'window since -5d', q: 'release notes', since: now - 5 * DAY, expectTop: U('changelog-1d') },
    { note: 'domain filter', q: 'calibration procedure', domain: 'eval.manual.test', expectTop: U('manual') },
    { note: 'since recent api', q: 'api rate limit', since: now - 2 * DAY, expectTop: U('api-notes') },
    { note: 'filter negative domain', q: 'derailleur', domain: 'eval.manual.test', expectNone: true },
    { note: 'filter negative since', q: 'widgets', since: now - DAY, expectNone: true },
  ];
}

interface PassageQuery {
  note: string;
  findQ: string; // locates the page via search (must match it)
  q: string; // the passage query under test
  expectMatch: boolean;
  includes?: string;
  excludes?: string;
}

const PASSAGE_QUERIES: PassageQuery[] = [
  { note: 'passage lighthouse', findQ: 'lighthouse keeper', q: 'lighthouse keeper', expectMatch: true, includes: 'lighthouse', excludes: 'origami' },
  { note: 'passage glacier', findQ: 'glacier melt survey', q: 'glacier melt survey', expectMatch: true, includes: 'glacier', excludes: 'lighthouse' },
  { note: 'passage origami', findQ: 'origami crane', q: 'origami crane', expectMatch: true, includes: 'origami', excludes: 'glacier' },
  { note: 'passage nomatch', findQ: 'lighthouse keeper', q: 'zzznothinghere', expectMatch: false },
];

export interface EvalResult {
  total: number;
  passed: number;
  failures: string[];
  lines: string[];
}

export async function runEval(now: number, embedText: EmbedFn): Promise<EvalResult> {
  const store = createStore(':memory:', embedText);
  store.ingest(buildCorpus(now));
  await store.flushEmbeddings();
  const lines: string[] = [];
  const failures: string[] = [];
  let passed = 0;
  const seenNotes = new Set<string>();
  const check = (ok: boolean, note: string, detail: string) => {
    lines.push(`${ok ? 'ok' : 'FAIL'}: eval ${note} (${detail})`);
    // sub-checks suffix their base note ("... stale flag", "... version") —
    // strip back to the base so coverage tracking sees one note per query
    seenNotes.add(note.replace(/ (stale flag|version)$/, ''));
    if (ok) passed++;
    else failures.push(note);
  };

  for (const eq of [...QUERIES, ...dynamicQueries(now)]) {
    seenNotes.add(eq.note);
    const hits = await store.search({
      q: eq.q,
      mode: eq.mode,
      domain: eq.domain,
      since: eq.since,
      until: eq.until,
      limit: 10,
    });
    if (eq.expectNone) {
      check(hits.length === 0, eq.note, `hits=${hits.length}`);
      continue;
    }
    const top = hits[0];
    if (eq.expectTop !== undefined) {
      check(top?.url === eq.expectTop, eq.note, `top=${top?.url ?? 'none'}`);
      if (eq.expectTitle !== undefined && top) {
        check(top.title === eq.expectTitle, `${eq.note} version`, `title=${top.title}`);
      }
      if (eq.expectStale !== undefined && top) {
        check(top.stale === eq.expectStale, `${eq.note} stale flag`, `stale=${top.stale}`);
      }
    } else if (eq.expect !== undefined) {
      const kk = 5;
      const idx = hits
        .slice(0, kk)
        .findIndex((h) => h.url === eq.expect && (eq.expectTitle === undefined || h.title === eq.expectTitle));
      check(idx !== -1, eq.note, idx === -1 ? `not in top${kk}` : `rank ${idx + 1}/${kk}`);
      // stale assertion applies to the expected hit itself, not rank 0 —
      // time decay intentionally lets fresh pages outrank an old capture
      if (eq.expectStale !== undefined && idx !== -1) {
        check(hits[idx]!.stale === eq.expectStale, `${eq.note} stale flag`, `stale=${hits[idx]!.stale}`);
      }
    }
  }

  // a page hit by both legs must appear exactly once in the merged result
  const dupHits = await store.search({ q: 'sqlite fts5 bm25', limit: 10 });
  check(new Set(dupHits.map((h) => h.id)).size === dupHits.length, 'hybrid no duplicate ids', `${dupHits.length} hits`);

  // vector-leg outage at search time: query embedding throws → hybrid must
  // still answer via the keyword leg (flush-time failures are covered in
  // selfcheck; this is the query-time catch-and-fallback path). The query
  // must have a real FTS match — the fusion-rescue query has none, so a
  // keyword-only fallback would legitimately return zero there.
  const outageStore = createStore(':memory:', async (text: string) => {
    if (text === 'derailleur cable tension') throw new Error('query embed outage');
    return embedText(text);
  });
  outageStore.ingest(buildCorpus(now));
  await outageStore.flushEmbeddings();
  const outageHits = await outageStore.search({ q: 'derailleur cable tension', mode: 'hybrid', limit: 10 });
  check(outageHits.length > 0, 'vec outage falls back to keyword', `${outageHits.length} hits`);
  outageStore.close();

  for (const pq of PASSAGE_QUERIES) {
    const hits = await store.search({ q: pq.findQ, mode: 'keyword', limit: 5 });
    const row = hits.length > 0 ? store.getPage(hits[0]!.id) : null;
    if (!row) {
      check(false, pq.note, 'page not found');
      continue;
    }
    const res = store.getPagePassages(hits[0]!.id, pq.q, row);
    let ok = res.matched === pq.expectMatch;
    if (ok && pq.includes) ok = res.passages.some((p) => p.includes(pq.includes!));
    if (ok && pq.excludes) ok = !res.passages.some((p) => p.includes(pq.excludes!));
    check(ok, pq.note, `matched=${res.matched} windows=${res.passages.length}`);
  }

  store.close();
  // verdict coverage (F5): every registered query/check must have produced at
  // least one verdict — a typo'd query field would otherwise run silently and
  // pass as part of "all pass"
  const expectedNotes = new Set([
    ...QUERIES.map((q) => q.note),
    ...dynamicQueries(now).map((q) => q.note),
    ...PASSAGE_QUERIES.map((q) => q.note),
    'hybrid no duplicate ids',
    'vec outage falls back to keyword',
  ]);
  for (const n of expectedNotes) {
    if (!seenNotes.has(n)) failures.push(`no verdict for: ${n}`);
  }
  const total = passed + failures.length;
  return { total, passed, failures, lines };
}
