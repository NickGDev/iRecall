// A/B gate for the q8 julia export: runs the EXACT production serialization
// (wasm encoder + logits contract copied from server/src/julia.ts) against
// both variants and compares keep-probabilities on real captures + probes.
// Ship gate: verdict agreement >= 95% and no case flipping hard across 0.5.
// Usage: npx tsx scripts/julia15-ab.ts
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(import.meta.dirname, '..');
const P32 = path.join(ROOT, 'server/models/julia-1.5');
const P8 = path.join(ROOT, 'server/models/julia-1.5-fp16');
const MAX_LENGTH = 1024;
const HEAD_LENGTH = 512;

interface WasmEncoderLike {
  encode(requestJson: string, maxLength: number, headLength: number, strict: boolean): string;
}
const wasmMod = (await import(path.join(P32, 'wasm/julia_webgpu_encode.js'))) as {
  default: (init: { module_or_path: Buffer }) => Promise<unknown>;
  WasmEncoder: new (tokenizerJson: string) => WasmEncoderLike;
};
await wasmMod.default({ module_or_path: readFileSync(path.join(P32, 'wasm/julia_webgpu_encode_bg.wasm')) });
const encoder = new wasmMod.WasmEncoder(readFileSync(path.join(P32, 'tokenizer.json'), 'utf8'));

const sessions = {
  fp32: await ort.InferenceSession.create(path.join(P32, 'model.onnx'), {
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  }),
  q8: await ort.InferenceSession.create(path.join(P8, 'model.onnx'), {
    graphOptimizationLevel: 'all',
    intraOpNumThreads: 2,
    interOpNumThreads: 1,
  }),
};

async function pKeep(
  key: 'fp32' | 'q8',
  rows: { state: string; question: string; options: string[] }[]
): Promise<number[]> {
  const session = sessions[key];
  const items = rows.map((row) => JSON.parse(encoder.encode(JSON.stringify(row), MAX_LENGTH, HEAD_LENGTH, false)));
  const batch = items.length;
  const length = Math.ceil(Math.max(...items.map((x) => x.ids.length)) / 8) * 8;
  const count = Math.max(...items.map((x) => x.markers.length));
  const ids = new BigInt64Array(batch * length);
  const attention = new BigInt64Array(batch * length);
  const positions = new BigInt64Array(batch * count);
  const mask = new Uint8Array(batch * count);
  const qtype = new BigInt64Array(batch);
  items.forEach((item, i) => {
    item.ids.forEach((id: number, j: number) => {
      ids[i * length + j] = BigInt(id);
      attention[i * length + j] = 1n;
    });
    item.markers.forEach((pos: number, j: number) => {
      positions[i * count + j] = BigInt(pos);
      mask[i * count + j] = 1;
    });
    qtype[i] = BigInt(item.qtype);
  });
  const out = await session.run({
    input_ids: new ort.Tensor('int64', ids, [batch, length]),
    attention_mask: new ort.Tensor('int64', attention, [batch, length]),
    marker_pos: new ort.Tensor('int64', positions, [batch, count]),
    marker_mask: new ort.Tensor('bool', mask, [batch, count]),
    qtype: new ort.Tensor('int64', qtype, [batch]),
  });
  const values = (await out.logits.getData()) as Float32Array;
  return items.map((item, i) => {
    const vals = Array.from(values.slice(i * count, i * count + item.markers.length));
    const peak = Math.max(...vals);
    const w = vals.map((x) => Math.exp(x - peak));
    const total = w.reduce((a, b) => a + b, 0) || 1;
    return w[0]! / total;
  });
}

// Same option phrasing as store/main setFocusCriteria: live rule keywords.
const db = new Database(path.join(ROOT, 'server/data/irecall.db'), { readonly: true });
const rules = db.prepare('SELECT keywords, topics FROM focus_rules WHERE enabled = 1').all() as {
  keywords: string;
  topics: string;
}[];
const keywords = rules.flatMap((r) => r.keywords.split('\n')).filter(Boolean);
const topics = rules.flatMap((r) => r.topics.split('\n')).filter(Boolean);
const keep = keywords.length > 0 ? keywords.join(', ') : topics.join('; ').slice(0, 480);
const options = [
  `technical: ${keep}`,
  'non-technical: games, gaming, entertainment, cooking, recipes, shopping, sports, gossip',
];

const cases: { label: string; state: string }[] = [
  { label: 'PROBE pancake recipe', state: 'Fluffy Buttermilk Pancakes\n\nWhisk two cups of flour with sugar, baking powder and a pinch of salt. Add buttermilk, melted butter and two eggs. Pour onto a hot griddle and flip when bubbles form. Serve with maple syrup.' },
  { label: 'PROBE sqlite internals', state: 'SQLite FTS5 internals\n\nThe full-text search extension maintains an inverted index in shadow tables. Query planning folds prefix queries into range scans over the terms table, and bm25 ranking weights rare terms higher.' },
  { label: 'PROBE onnx runtime docs', state: 'ONNX Runtime performance tuning\n\nIntra-op parallelism controls the thread pool used inside individual operators. Setting intra_op_num_threads to 2 caps CPU bursts on shared machines at a small latency cost.' },
];
for (const row of db.prepare('SELECT title, content, domain FROM pages ORDER BY id').all() as {
  title: string | null;
  content: string;
  domain: string;
}[]) {
  cases.push({ label: `db:${row.domain}`, state: `${row.title ?? ''}\n\n${row.content.slice(0, 2000)}` });
}

const rows = cases.map((c) => ({ state: c.state, question: 'Which category fits this page?', options }));
const t0 = Date.now();
const p32 = await pKeep('fp32', rows);
const t1 = Date.now();
const p8 = await pKeep('q8', rows);
const t2 = Date.now();

let agree = 0;
let hardFlips = 0;
let maxDelta = 0;
console.log('case                          fp32(keep)  q8(keep)  agree');
for (let i = 0; i < cases.length; i++) {
  const a = p32[i]!;
  const b = p8[i]!;
  const va = a >= 0.5;
  const vb = b >= 0.5;
  const ok = va === vb;
  if (ok) agree++;
  if (!ok && Math.abs(a - 0.5) > 0.15 && Math.abs(b - 0.5) > 0.15) hardFlips++;
  maxDelta = Math.max(maxDelta, Math.abs(a - b));
  console.log(
    `${cases[i]!.label.slice(0, 28).padEnd(30)}${a.toFixed(3).padStart(8)}   ${b.toFixed(3).padStart(8)}  ${ok ? 'ok' : 'FLIP'}`
  );
}
const n = cases.length;
console.log(
  `\nagreement ${agree}/${n} (${Math.round((agree / n) * 100)}%), hard flips ${hardFlips}, max |Δp| ${maxDelta.toFixed(3)}`
);
console.log(`latency batch of ${n}: fp32 ${Math.round((t1 - t0) / n)}ms/page, q8 ${Math.round((t2 - t1) / n)}ms/page`);
