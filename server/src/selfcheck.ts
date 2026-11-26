// Runnable check for store logic: dedup + FTS + vector/hybrid search.
// Uses a deterministic fake embedder so no model download is needed. Run: npm run selfcheck
import type { EmbedFn } from './store.js';
import { createStore, EMBED_DIM } from './store.js';
import { runEval } from './eval-queries.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

// Deterministic hash embedder: similar tokens -> similar dims.
const fakeEmbed: EmbedFn = async (text) => {
  const vec = new Float32Array(EMBED_DIM);
  for (const token of text.toLowerCase().split(/\W+/)) {
    if (!token) continue;
    const h = [...token].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % EMBED_DIM, 7);
    vec[h] += 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
};

const store = createStore(':memory:', fakeEmbed);

const pageA = {
  url: 'https://example.com/sqlite-guide',
  title: 'SQLite Guide',
  content: 'SQLite FTS5 gives full-text search over local pages. '.repeat(20),
};
const pageB = {
  url: 'https://example.org/recipe',
  title: 'Pancakes',
  content: 'How to cook pancakes with flour and milk. '.repeat(20),
};

const r1 = store.ingest([pageA, pageB]);
assert(r1.inserted === 2 && r1.skipped === 0, 'ingest inserts 2');

const r2 = store.ingest([pageA]);
assert(r2.inserted === 0 && r2.skipped === 1, 'identical re-ingest skipped');

const r3 = store.ingest([{ url: 'javascript:void(0)', content: 'x' }, { url: 'https://ok.com/a', content: '' }, { url: 123, content: 'x' }]);
assert(r3.inserted === 0 && r3.skipped === 3, 'invalid pages rejected');

// content beyond MAX_CONTENT_BYTES (2MB) rejected before it ever hits the DB
const rBig = store.ingest([{ url: 'https://big.example/x', content: 'x'.repeat(2_000_001) }]);
assert(rBig.inserted === 0 && rBig.skipped === 1, 'oversized content rejected');

// FTS operator characters in raw queries must not throw (ftsQuery quoting)
const opHits = await store.search({ q: 'OR AND NOT (sqlite" NEAR' });
assert(Array.isArray(opHits), 'operator-laden query does not throw');

const hits = await store.search({ q: 'sqlite' });
assert(hits.length === 1 && hits[0]!.url === pageA.url, 'hybrid finds right page');

const hits2 = await store.search({ q: 'pancakes flour', mode: 'keyword' });
assert(hits2.length === 1 && hits2[0]!.url === pageB.url, 'keyword multi-token match');

const hits3 = await store.search({ q: 'local pages full-text' });
assert(hits3.length >= 1 && hits3[0]!.url === pageA.url, 'semantic query matches topic');

// filters must hold on the vector leg too (hybrid mode), not just keyword leg
const domainFiltered = await store.search({ q: 'local pages full-text', domain: 'no-such.example' });
assert(domainFiltered.length === 0, 'hybrid domain filter excludes vector-leg hits');
const timeFiltered = await store.search({ q: 'local pages full-text', until: Date.now() - 86_400_000 });
assert(timeFiltered.length === 0, 'hybrid until filter excludes vector-leg hits');
const domainKept = await store.search({ q: 'local pages full-text', domain: 'example.com' });
assert(domainKept.length === 1 && domainKept[0]!.url === pageA.url, 'hybrid domain filter keeps matching page');

// getPage returns the full row incl. content
const got = store.getPage(hits[0]!.id);
assert(got !== null && got.content.includes('SQLite FTS5') && got.url === pageA.url, 'getPage returns full page');
assert(store.getPage(999_999) === null, 'getPage missing id -> null');

// passage mode: q cuts windows around query tokens; no match falls back to head
store.ingest([
  {
    url: 'https://example.com/long-doc',
    title: 'Long Document',
    content:
      'ALPHAMARK intro sentence. ' +
      'filler sentence about plumbing. '.repeat(160) +
      'OMEGASECTION: quilting bobbins and seam allowances. '.repeat(6),
  },
]);
const longHits = await store.search({ q: 'quilting bobbins', mode: 'keyword' });
assert(longHits.length === 1, 'long doc searchable');
const longFull = store.getPage(longHits[0]!.id)!;
assert(longFull.content.includes('ALPHAMARK'), 'getPage full row unchanged');
const pass = store.getPagePassages(longHits[0]!.id, 'quilting bobbins', longFull);
assert(pass.matched === true, 'passage match detected');
assert(pass.passages[0]!.includes('bobbins'), 'passage window hits target section');
assert(!pass.passages[0]!.includes('ALPHAMARK'), 'passage excludes distant head');
assert(pass.totalChars < 4500, 'passage budget respected');
const miss = store.getPagePassages(longHits[0]!.id, 'zzznomatchword', longFull);
assert(miss.matched === false && miss.passages[0]!.includes('ALPHAMARK'), 'no match falls back to page head');
const ops = store.getPagePassages(longHits[0]!.id, 'OR AND NOT', longFull);
assert(ops.matched === false, 'operator-literal query no match, no throw');
const quoted = store.getPagePassages(longHits[0]!.id, '"', longFull);
assert(quoted.matched === false, 'quote-only query head fallback, no throw');

// review fixes: matched reflects the FTS gate (CJK falls back to head, still
// honest); greedy windows don't overlap
store.ingest([{ url: 'https://example.com/cjk', title: 'CJK Notes', content: '量子計算 research notes. '.repeat(12) }]);
const cjkHits = await store.search({ q: '量子計算', mode: 'keyword' });
assert(cjkHits.length === 1, 'cjk page searchable');
const cjkFull = store.getPage(cjkHits[0]!.id)!;
const cjkPass = store.getPagePassages(cjkHits[0]!.id, '量子計算', cjkFull);
assert(cjkPass.matched === true && cjkPass.passages[0]!.includes('量子計算'), 'cjk match honest, head fallback');

store.ingest([
  {
    url: 'https://example.com/spread',
    title: 'Spread',
    content:
      'MARKX alpha. ' +
      'filler text padding. '.repeat(150) +
      'MARKY beta. ' +
      'filler text padding. '.repeat(150) +
      'MARKZ gamma. '.repeat(6),
  },
]);
const spreadHits = await store.search({ q: 'MARKX MARKY MARKZ alpha beta gamma', mode: 'keyword' });
assert(spreadHits.length === 1, 'spread page searchable');
const spreadFull = store.getPage(spreadHits[0]!.id)!;
const spreadPass = store.getPagePassages(spreadHits[0]!.id, 'MARKX MARKY MARKZ alpha beta gamma', spreadFull);
assert(spreadPass.passages.length === 3, 'three separate windows');
assert(spreadPass.passages[0]!.includes('MARKX') && !spreadPass.passages[0]!.includes('MARKY'), 'window 1 local');
assert(spreadPass.passages[1]!.includes('MARKY') && !spreadPass.passages[1]!.includes('MARKX'), 'window 2 local, no overlap');

await store.flushEmbeddings();
const none = await store.search({ q: 'zzz-no-such-token', mode: 'keyword' });
assert(none.length === 0, 'keyword no-match -> empty');

const s = store.stats();
assert(s.pages === 5 && s.embedded === 5, 'stats counts incl embeddings');

// temporal: superseded + stale + decay

// same-day content change: new row (not deduped) — url_day_hash only
// backstops the same-url+same-content race, content change inserts
const rSameDay = store.ingest([
  { url: 'https://example.com/live-doc', title: 'live v1', content: 'live document state one. '.repeat(20), capturedAt: Date.now() - 60_000 },
]);
await store.flushEmbeddings();
const rSameDay2 = store.ingest([
  { url: 'https://example.com/live-doc', title: 'live v2', content: 'live document state two revised. '.repeat(20) },
]);
await store.flushEmbeddings();
assert(rSameDay.inserted === 1 && rSameDay2.inserted === 1, 'same-day content change inserts both');
const liveHits = await store.search({ q: 'state two revised', mode: 'keyword' });
assert(liveHits.length === 1 && liveHits[0]!.supersededBy === null, 'same-day newer version current');
const liveOld = await store.search({ q: 'state one', mode: 'keyword' });
assert(liveOld.length === 1 && liveOld[0]!.supersededBy !== null, 'same-day older version superseded');

// stale via age alone: >90d, no newer capture of the same url
const aged = Date.now() - 95 * 86_400_000;
store.ingest([{ url: 'https://example.com/aged', title: 'aged', content: 'aged unique parchment archive. '.repeat(20), capturedAt: aged }]);
await store.flushEmbeddings();
const agedHits = await store.search({ q: 'parchment archive', mode: 'keyword' });
assert(agedHits.length === 1 && agedHits[0]!.stale === true && agedHits[0]!.supersededBy === null, 'stale via age alone, no superseder');

const old = Date.now() - 120 * 86_400_000;
store.ingest([
  { url: 'https://example.com/doc', title: 'V1', content: 'Alpha document about widgets. '.repeat(20), capturedAt: old },
  { url: 'https://example.com/doc', title: 'V2', content: 'Updated document about gadgets. '.repeat(20) },
]);
await store.flushEmbeddings();
const v1hits = await store.search({ q: 'widgets', mode: 'keyword' });
assert(v1hits.length === 1 && v1hits[0]!.supersededBy !== null && v1hits[0]!.stale === true, 'old version flagged superseded+stale');
assert(v1hits[0]!.ageDays > 100, 'ageDays computed');
const v2hits = await store.search({ q: 'gadgets', mode: 'keyword' });
assert(v2hits.length === 1 && v2hits[0]!.supersededBy === null, 'current version not flagged');

// deletes
const del = store.deletePages({ domain: 'example.org' });
assert(del === 1, 'domain delete removes 1');
const kw = await store.search({ q: 'pancakes', mode: 'keyword' });
assert(kw.length === 0, 'deleted page gone from fts');
const docId = v2hits[0]!.id;
assert(store.deletePage(docId) === 1, 'id delete works');
assert(store.stats().embedded === 8, 'vector rows cascade-deleted');

// domain filter www-tolerance: users type the bare domain, captures store
// the full host (linkedin.com vs www.linkedin.com was a zero-hit trap)
store.ingest([{ url: 'https://www.example-x.com/post', title: 'x post', content: 'example-x www tolerance capture. '.repeat(20) }]);
await store.flushEmbeddings();
const wwwHits = await store.search({ q: 'www tolerance capture', domain: 'example-x.com' });
assert(wwwHits.length === 1 && wwwHits[0]!.domain === 'www.example-x.com', 'domain filter www-tolerant (bare input)');
const wwwHits2 = await store.search({ q: 'www tolerance capture', domain: 'www.example-x.com' });
assert(wwwHits2.length === 1, 'domain filter www-tolerant (www input)');

// purge-all path (dashboard 'all' sends olderThanDays=0): must delete everything
store.ingest([{ url: 'https://left.io/x', title: 'leftover', content: 'leftover content page. '.repeat(20), capturedAt: Date.now() - 5000 }]);
await store.flushEmbeddings();
const purged = store.deletePages({ olderThanDays: 0 });
assert(purged >= 1 && store.stats().pages === 0, 'olderThanDays=0 purges all rows');

// embed-failure recovery: transient failures retry (requeue), permanent drop
// after 3 attempts — no silent loss, no poison
let failLeft = 1;
const flakyStore = createStore(':memory:', async (text: string) => {
  if (failLeft > 0) {
    failLeft--;
    throw new Error('transient model failure');
  }
  return fakeEmbed(text);
});
flakyStore.ingest([{ url: 'https://flaky.io/a', title: 'flaky', content: 'flaky page content. '.repeat(20) }]);
await flakyStore.flushEmbeddings(); // attempt fails, job requeued
assert(flakyStore.stats().embedded === 0, 'failed embeds not recorded');
await flakyStore.flushEmbeddings(); // retry succeeds
assert(flakyStore.stats().embedded === 1, 'requeued embed retried and succeeded');

// permanent embed failure: 3 attempts then poisoned — skipped (not dropped,
// not retried forever) until restart. Each flushEmbeddings = one drain slice
// = one attempt for a single page.
let failAlways = true;
const poisonStore = createStore(':memory:', async (text: string) => {
  if (failAlways) throw new Error('permanent model failure');
  return fakeEmbed(text);
});
poisonStore.ingest([{ url: 'https://poison.io/a', title: 'poison', content: 'poison page content. '.repeat(20) }]);
await poisonStore.flushEmbeddings();
await poisonStore.flushEmbeddings();
await poisonStore.flushEmbeddings(); // 3rd attempt marks the page poisoned
assert(poisonStore.stats().embedded === 0, 'permanently failing embed never recorded');
failAlways = false;
await poisonStore.flushEmbeddings(); // embedder recovered — still skipped
assert(poisonStore.stats().embedded === 0, 'poisoned page skipped until restart');
poisonStore.close();

// /recent since filter (phase-4 recent(hours))
const store2 = createStore(':memory:', fakeEmbed);
store2.ingest([
  { url: 'https://old.io/a', title: 'old', content: 'old content page. '.repeat(20), capturedAt: Date.now() - 86_400_000 },
  { url: 'https://new.io/b', title: 'new', content: 'new content page. '.repeat(20) },
]);
const recents = store2.recent(50, Date.now() - 3_600_000);
assert(recents.length === 1 && recents[0]!.domain === 'new.io', 'recent(honors since)');
const allRecent = store2.recent(50);
assert(
  allRecent.length === 2 &&
    typeof allRecent[0]!.ageDays === 'number' &&
    'supersededBy' in allRecent[0]! &&
    'stale' in allRecent[0]!,
  'recent(returns annotated hits)'
);
assert(store2.recent(1).length === 1, 'recent honors limit');

// focus rules: semantic keep/prune via topics + keyword boost + embed-drain gate
const rid = await store2.setFocusRule({
  domain: 'reddit.com',
  topics: ['llm machine learning models'],
  keywords: ['quantized'],
  threshold: 0.35,
});
const rulesList = store2.listFocusRules();
assert(rulesList.length === 1 && rulesList[0]!.hasVectors && rulesList[0]!.enabled, 'focus rule saved with topic vectors');
store2.ingest([
  { url: 'https://reddit.com/r/LocalLLaMA/comments/1', title: 'best local llm setup', content: 'llm models machine learning inference. '.repeat(15) },
  { url: 'https://www.reddit.com/r/food/comments/2', title: 'pancake recipe', content: 'flour milk butter syrup recipe. '.repeat(15) },
]);
await store2.flushEmbeddings();
assert(store2.stats().pages === 3 && store2.stats().embedded === 3, 'embed drain keeps on-focus, prunes off-focus');
store2.ingest([
  { url: 'https://old.reddit.com/r/recipes/comments/3', title: 'cake', content: 'flour sugar eggs. '.repeat(15) },
  { url: 'https://reddit.com/r/LocalLLaMA/comments/5', title: 'weights', content: 'quantized weights inference. '.repeat(15) },
]);
const swept = await store2.sweepFocusRules();
// cake is pruned exactly once — by the embed drain or by the sweep (benign race)
assert(swept + store2.focusPruned() === 2 && store2.stats().pages === 4, 'focus sweep prunes stored off-focus page, keyword boost keeps');
const preview = await store2.previewFocusRule({ domain: 'reddit.com', topics: ['pancake recipe breakfast'], keywords: [], threshold: 0.35 });
assert(preview.wouldPrune === 2 && preview.kept === 0 && preview.undecided === 0, 'preview flags off-focus stored pages with scores');

// confidence + category: score normalized per result set (top = 1), category
// derived from the rule's topic vectors, filters applied post-scoring
const scored = await store2.search({ q: 'llm models machine learning' });
assert(scored.length > 0 && scored[0]!.score === 1, 'top hit confidence = 1');
assert(scored.every((h, i) => i === 0 || h.score <= scored[i - 1]!.score), 'scores non-increasing');
const kwScored = await store2.search({ q: 'llm models machine learning', mode: 'keyword' });
assert(kwScored.length > 0 && kwScored[0]!.score === 1, 'top hit confidence = 1 (keyword mode too)');
const llm = scored.find((h) => h.url.includes('comments/1'));
assert(llm !== undefined && llm.categoryId === rid && llm.category !== null, 'rule-matching page categorized');
const pancake = scored.find((h) => h.url.includes('comments/2'));
assert(pancake === undefined || pancake.categoryId === null, 'off-topic page uncategorized');
const byCat = await store2.search({ q: 'llm models machine learning', categoryId: rid });
assert(byCat.length >= 1 && byCat.every((h) => h.categoryId === rid), 'category filter keeps only rule-matching');
const tight = await store2.search({ q: 'llm models machine learning', minScore: 0.98 });
assert(tight.length >= 1 && tight.every((h) => h.score >= 0.98), 'minScore cuts on normalized score');
const loose = await store2.search({ q: 'llm models machine learning', minScore: 0.5 });
assert(loose.length >= tight.length, 'looser minScore keeps at least as many');

assert(store2.deleteFocusRule(rid) === 1, 'focus rule delete works');

// keyword gate word boundaries: "rag" hits the standalone token, not the
// "rag" inside "storage" (substring matching was a systemic false-keep)
const kwStore = createStore(':memory:', fakeEmbed);
await kwStore.setFocusRule({ topics: ['llm and rag pipelines'], keywords: ['llm', 'rag'], threshold: 0.35 });
assert(kwStore.keywordHit('a.com', null, 'building a rag pipeline over sqlite') === true, 'keyword gate hits standalone token');
assert(kwStore.keywordHit('a.com', null, 'storage systems and averages') === false, 'keyword gate rejects mid-word substring');
kwStore.close();

// exemplars: teaching a page keeps similar pages in the verdict; forgetting
// removes the signal — the learn/unteach loop the popup + MCP teach feed.
const exStore = createStore(':memory:', fakeEmbed);
await exStore.setFocusRule({ topics: ['llm machine learning models'], keywords: [], threshold: 0.55 });
const taught = await exStore.addExemplar({
  url: 'https://huggingface.co/collections/gemma',
  title: 'gemma-4-MNN - a Collection',
  content: 'gemma mnn quantized text generation models collection. ',
});
assert(taught.hasVector, 'exemplar embedded at teach time');
const kept = await exStore.focusCheck(
  'collection page',
  'huggingface.co',
  'gemma mnn quantized text generation models collection list'
);
assert(kept === true, 'exemplar similarity keeps a similar page');
assert(exStore.deleteExemplar(taught.id) === 1, 'exemplar delete works');
const keptAfterForget = await exStore.focusCheck(
  'collection page',
  'huggingface.co',
  'gemma mnn quantized text generation models collection list'
);
assert(keptAfterForget === false, 'after forget the same page is pruned again');
exStore.close();

store2.close();

store.close();

// --- pages browse: day buckets + paged listing + retention rules --------------
// Hermetic store; day strings derived the same way the runner's local clock
// does (SQLite 'localtime' == JS Date local) so the check is TZ-independent.
const store3 = createStore(':memory:', fakeEmbed);
const localDay = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
// Anchor at local noon: captures never sit near a midnight boundary, so
// bucket membership can't flip if the check runs across midnight.
const noon = new Date();
noon.setHours(12, 0, 0, 0);
const base = noon.getTime();
const t2 = base - 2 * 86_400_000;
const t2b = t2 + 3_600_000;
const t1 = base - 86_400_000;
store3.ingest([
  { url: 'https://a.test/one', title: 'one', content: 'alpha content page one. '.repeat(15), capturedAt: t2 },
  { url: 'https://a.test/two', title: 'two', content: 'alpha content page two. '.repeat(15), capturedAt: t2b },
  { url: 'https://www.b.test/x', title: 'x', content: 'beta content page x. '.repeat(15), capturedAt: t1 },
  { url: 'https://sub.b.test/y', title: 'y', content: 'beta content page y. '.repeat(15), capturedAt: base },
]);
const buckets = store3.days(60);
assert(buckets.length === 3, 'days lists capture-days only (no padding)');
assert(buckets[0]!.day === localDay(base) && buckets[0]!.count === 1, 'days newest first, count right');
assert(buckets[2]!.day === localDay(t2) && buckets[2]!.count === 2, 'older day bucketed with both captures');
const dayRows = store3.listPages({ day: localDay(t2), limit: 50, offset: 0 });
assert(dayRows.total === 2 && dayRows.pages[0]!.capturedAt === t2b, 'day listing newest first, total right');
assert(typeof dayRows.pages[0]!.ageDays === 'number' && 'stale' in dayRows.pages[0]!, 'day listing annotated');
assert(store3.listPages({ domain: 'b.test', limit: 50, offset: 0 }).total === 1, 'site listing exact+www only (no subdomains)');
assert(store3.listPages({ domain: 'www.b.test', limit: 50, offset: 0 }).total === 1, 'site listing www-tolerant');
const paged = store3.listPages({ domain: 'a.test', limit: 1, offset: 1 });
assert(paged.total === 2 && paged.pages.length === 1 && paged.pages[0]!.capturedAt === t2, 'offset paging walks the day');

// retention rules: matches, sweep, most-aggressive-wins, future gate, inert
const siteRule = store3.addRetentionRule({ scope: 'site', key: 'a.test', mode: 'maxAge', value: 1 });
assert(store3.retentionRuleMatches(siteRule) === 2, 'site rule matches bare domain');
const deleted = store3.applyRetentionRules(base);
assert(deleted === 2 && store3.stats().pages === 2, 'maxAge site rule deletes only aged matches');
const pageList = store3.listRetentionRules();
assert(pageList.find((r) => r.id === siteRule.id)?.deleted === 2, 'rule tracks lifetime deletions');
const futureRule = store3.addRetentionRule({ scope: 'page', key: 'https://sub.b.test/y', mode: 'on', value: base + 86_400_000 });
assert(store3.applyRetentionRules(base) === 0 && store3.stats().pages === 2, 'future delete-on rule deletes nothing early');
assert(store3.applyRetentionRules(base + 2 * 86_400_000) === 1, 'delete-on rule fires once its date passes');
store3.setRetention(30);
const inertRule = store3.addRetentionRule({ scope: 'site', key: 'b.test', mode: 'maxAge', value: 90 });
assert(store3.retentionRuleMatches(inertRule) === 1, 'inert rule still reports its match count');
assert(store3.applyRetentionRules(Date.now()) === 0, 'inert rule (maxAge >= global retention) deletes nothing');
assert(store3.deleteRetentionRule(futureRule.id) === true, 'retention rule delete works');
assert(store3.deleteRetentionRule(999) === false, 'retention rule delete unknown id -> false');

// DELETE /pages combos: domain+olderThanDays AND together; ?url= alone works
store3.ingest([
  { url: 'https://c.test/old', title: 'old', content: 'gamma old page. '.repeat(15), capturedAt: base - 10 * 86_400_000 },
  { url: 'https://c.test/new', title: 'new', content: 'gamma new page. '.repeat(15) },
]);
assert(store3.deletePages({ domain: 'c.test', olderThanDays: 5 }) === 1, 'domain+olderThanDays AND-combo');
assert(store3.deletePages({ url: 'https://c.test/new' }) === 1, 'url-scoped delete');
assert(store3.stats().pages === 1, 'only the untouched page survives the combos');
store3.close();

// golden-query eval: corpus + queries with known right pages (see
// eval-queries.ts). Hermetic — fake embedder — so it measures the search
// mechanism, not granite quality.
const ev = await runEval(Date.now(), fakeEmbed);
for (const line of ev.lines) console.log(line);
assert(ev.failures.length === 0, `eval set: ${ev.passed}/${ev.total} golden queries pass`);

console.log('selfcheck: PASS');
