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

await store.flushEmbeddings();
const none = await store.search({ q: 'zzz-no-such-token', mode: 'keyword' });
assert(none.length === 0, 'keyword no-match -> empty');

const s = store.stats();
assert(s.pages === 3 && s.embedded === 3, 'stats counts incl embeddings');

// temporal: superseded + stale + decay
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
assert(store.stats().embedded === 3, 'vector rows cascade-deleted');

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

// golden-query eval: corpus + queries with known right pages (see
// eval-queries.ts). Hermetic — fake embedder — so it measures the search
// mechanism, not granite quality.
const ev = await runEval(Date.now(), fakeEmbed);
for (const line of ev.lines) console.log(line);
assert(ev.failures.length === 0, `eval set: ${ev.passed}/${ev.total} golden queries pass`);

console.log('selfcheck: PASS');
