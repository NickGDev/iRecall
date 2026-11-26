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
  expect?: string; // url must appear in top-k
  expectTop?: string; // url must be rank 1
  expectTitle?: string; // disambiguate same-url versions (V1/V2)
  expectStale?: boolean; // the expected hit's stale flag must equal this
  mode?: 'keyword' | 'hybrid';
  domain?: string;
  since?: number;
  until?: number;
}

const U = (slug: string) => `https://eval.${slug.replace(/-/g, '')}.test/${slug}`;

function page(slug: string, tokens: string, repeats = 12): PageInput {
  return { url: U(slug), title: slug, content: `${tokens} `.repeat(repeats) };
}

export function buildCorpus(now: number): PageInput[] {
  return [
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
  // scattered multi-token: all tokens only co-occur in target
  { note: 'scattered sqlite', q: 'sqlite fts5 bm25 wal checkpoint journal', expect: U('sqlite-notes') },
  { note: 'scattered react', q: 'react hooks rerender effect memo dependency', expect: U('react-hooks') },
  { note: 'scattered rust', q: 'rust async await pin future executor', expect: U('rust-async') },
  { note: 'scattered dns', q: 'homelab dns pihole resolver upstream cache', expect: U('homelab-dns') },
  { note: 'scattered mcp', q: 'mcp protocol stdio tools transport schema', expect: U('mcp-spec') },
  { note: 'scattered vector', q: 'vectordb embeddings cosine ann recall quantization', expect: U('vector-notes') },
  { note: 'scattered k8s', q: 'kubernetes pod node scheduler affinity', expect: U('k8s-basics') },
  { note: 'scattered api', q: 'api rate limit retry backoff quota', expect: U('api-notes') },
  // keyword vs hybrid parity: same target lands in top-5 both modes
  { note: 'parity keyword', q: 'compost mulch worms', mode: 'keyword', expect: U('gardening') },
  { note: 'parity hybrid', q: 'compost mulch worms', mode: 'hybrid', expect: U('gardening') },
  { note: 'parity keyword 2', q: 'grinder extraction', mode: 'keyword', expect: U('coffee-roast') },
  { note: 'parity hybrid 2', q: 'grinder extraction', mode: 'hybrid', expect: U('coffee-roast') },
  // temporal: superseded V1 flagged stale — keyword mode, since FTS matches
  // V1 exclusively ('widgets' only in V1) while hybrid's time decay rightly
  // buries a 120d-old capture under fresh pages
  { note: 'superseded V1 stale', q: 'widgets calibration', mode: 'keyword', expectTop: U('manual'), expectStale: true },
  { note: 'superseded V2 top', q: 'gadgets calibration', expectTop: U('manual'), expectStale: false },
  // window/domain queries need `now` — see dynamicQueries
];

// time-window + domain-filter cases; built at runtime for epoch math
function dynamicQueries(now: number): EvalQuery[] {
  return [
    { note: 'window until -5d', q: 'release notes', until: now - 5 * DAY, expect: U('changelog-10d') },
    { note: 'window since -5d', q: 'release notes', since: now - 5 * DAY, expect: U('changelog-1d') },
    { note: 'domain filter', q: 'calibration procedure', domain: 'eval.manual.test', expect: U('manual') },
    { note: 'since recent api', q: 'api rate limit', since: now - 2 * DAY, expect: U('api-notes') },
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
  const check = (ok: boolean, note: string, detail: string) => {
    lines.push(`${ok ? 'ok' : 'FAIL'}: eval ${note} (${detail})`);
    if (ok) passed++;
    else failures.push(note);
  };

  for (const eq of [...QUERIES, ...dynamicQueries(now)]) {
    const hits = await store.search({
      q: eq.q,
      mode: eq.mode,
      domain: eq.domain,
      since: eq.since,
      until: eq.until,
      limit: 10,
    });
    const top = hits[0];
    if (eq.expectTop !== undefined) {
      check(top?.url === eq.expectTop, eq.note, `top=${top?.url ?? 'none'}`);
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
  const total = passed + failures.length;
  return { total, passed, failures, lines };
}
