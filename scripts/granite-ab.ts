// A/B gate for granite q8 vs fp32 embeddings: cosine parity per text plus
// cross-text similarity structure (exemplar thresholds live at 0.85 on the
// page↔page scale — a systematic downward shift would silently break teach).
// Usage: npx tsx scripts/granite-ab.ts
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..');
env.cacheDir = path.join(ROOT, 'server', 'models');
env.allowLocalModels = true;
const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';

const db = new Database(path.join(ROOT, 'server/data/irecall.db'), { readonly: true });
const rows = db
  .prepare('SELECT title, content, domain FROM pages ORDER BY id LIMIT 4')
  .all() as { title: string | null; content: string; domain: string }[];
const texts = [
  ...rows.map((r) => `${r.title ?? ''}\n\n${r.content.slice(0, 2000)}`),
  'Fluffy Buttermilk Pancakes: whisk flour, sugar, baking powder. Add buttermilk, melted butter, eggs. Griddle, flip at bubbles, serve with syrup.',
];

async function load(dtype: 'fp32' | 'q8') {
  const tok = (await AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as (
    texts: string[],
    opts?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  const before = process.memoryUsage.rss();
  const model = (await AutoModel.from_pretrained(MODEL_ID, { dtype })) as unknown as (
    inputs: Record<string, unknown>
  ) => Promise<{ sentence_embedding: { normalize: () => { tolist: () => number[][] } } }>;
  const after = process.memoryUsage.rss();
  const inputs = await tok(texts, { padding: true, truncation: true, max_length: 8192 });
  const out = await model(inputs);
  const vecs = out.sentence_embedding.normalize().tolist().map((v) => new Float32Array(v));
  return { model, tok, vecs, rssDelta: Math.round((after - before) / 1048576) };
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

const f32 = await load('fp32');
const q8 = await load('q8');
console.log(`rss while loading: fp32 +${f32.rssDelta}MB, q8 +${q8.rssDelta}MB`);
console.log('\nsame-text cosine fp32↔q8 (1.0 = identical direction):');
for (let i = 0; i < texts.length; i++) {
  console.log(`  text ${i} (${rows[i]?.domain ?? 'probe'}): ${dot(f32.vecs[i]!, q8.vecs[i]!).toFixed(4)}`);
}
console.log('\ncross-text similarity pairs (fp32 | q8):');
for (let i = 0; i < texts.length; i++) {
  for (let j = i + 1; j < texts.length; j++) {
    const a = dot(f32.vecs[i]!, f32.vecs[j]!).toFixed(3);
    const b = dot(q8.vecs[i]!, q8.vecs[j]!).toFixed(3);
    const flag = Math.abs(Number(a) - Number(b)) > 0.02 ? '  <-- drift' : '';
    console.log(`  ${i}↔${j}: ${a} | ${b}${flag}`);
  }
}
