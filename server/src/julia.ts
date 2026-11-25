// Julia-1 decision model (SupersonicLabs, ONNX export) — the early filter:
// one fast CPU forward pass decides keep/drop BEFORE any embedding work.
// Ported from the official Julia-1-ONNX index.js (WebGPU) to onnxruntime-node;
// same weights, same serialization contract:
//   [CLS] "<type> question: <q>" (head ≤ headLength tokens)
//   [MASK] option₁ (≤ 48 tokens each, marker at every MASK)
//   [SEP] <state tokens up to remaining budget> [SEP]
// The graph scores each marker position; softmax over options = probabilities.
// Encoding uses the vendor's Rust WASM tokenizer (wasm/), NOT transformers.js:
// the JS tokenizer diverges on whitespace runs (double spaces etc.), which
// flipped verdicts on real captured pages (2026-11-25 parity investigation —
// vendor tokens score 100/100 on parity-cases.json, transformers.js 98/100
// with multi-logit errors). strict=false: long states truncate, like before.
import * as ort from 'onnxruntime-node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const MODEL_DIR = path.join(here, '..', 'models', process.env.JULIA_MODEL_DIR ?? 'julia-1.5');
const MAX_LENGTH = 1024;
const HEAD_LENGTH = Number(process.env.JULIA_HEAD_LENGTH) || 512; // Julia-1.5 contract (Julia-1 used 256)
const CHUNK = 16;
const THRESHOLD = (() => {
  const v = Number(process.env.JULIA_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.5;
})();

// Minimal slice of the vendored wasm-bindgen API (wasm/julia_webgpu_encode.d.ts).
interface WasmEncoderLike {
  encode(requestJson: string, maxLength: number, headLength: number, strict: boolean): string;
}

let session: ort.InferenceSession | null = null;
let encoder: WasmEncoderLike | null = null;
let loading: Promise<boolean> | null = null; // resolves true = model ready
let warned = false;
let options: string[] | null = null; // [keep, drop], rebuilt from focus topics

async function load(): Promise<boolean> {
  const graph = path.join(MODEL_DIR, 'model.onnx');
  const weights = path.join(MODEL_DIR, 'model.onnx.data');
  const glue = path.join(MODEL_DIR, 'wasm', 'julia_webgpu_encode.js');
  const wasm = path.join(MODEL_DIR, 'wasm', 'julia_webgpu_encode_bg.wasm');
  const tokenizerJson = path.join(MODEL_DIR, 'tokenizer.json');
  if (!fs.existsSync(graph) || !fs.existsSync(weights) || !fs.existsSync(glue) || !fs.existsSync(wasm) || !fs.existsSync(tokenizerJson)) {
    if (!warned) {
      warned = true;
      console.log('julia-1 model files missing — early filter disabled (fail-open)');
    }
    return false;
  }
  const wasmMod = (await import(glue)) as {
    default: (init: { module_or_path: Buffer }) => Promise<unknown>;
    WasmEncoder: new (tokenizerJson: string) => WasmEncoderLike;
  };
  await wasmMod.default({ module_or_path: fs.readFileSync(wasm) });
  encoder = new wasmMod.WasmEncoder(fs.readFileSync(tokenizerJson, 'utf8'));
  // model.onnx.data sits next to model.onnx with the graph-recorded name — ORT
  // resolves it automatically; passing it via the option double-buffers 550MB.
  session = await ort.InferenceSession.create(graph, {
    graphOptimizationLevel: 'all',
  });
  // warm
  await logits([{ state: '', question: 'Ready?', options: ['Yes', 'No'] }]);
  console.log(`julia loaded (${path.basename(MODEL_DIR)}, threshold ${THRESHOLD})`);
  return true;
}

function ready(): Promise<boolean> {
  if (process.env.JULIA_DISABLE === '1') return Promise.resolve(false);
  if (!loading) {
    loading = load().catch((err) => {
      loading = null;
      console.error('julia-1 load failed — early filter disabled:', err instanceof Error ? err.message : err);
      return false;
    });
  }
  return loading;
}

async function logits(rows: { state: string; question: string; options: string[] }[]): Promise<number[][]> {
  if (!session || !encoder) throw new Error('julia session not loaded');
  const items = rows.map((row) => JSON.parse(encoder!.encode(JSON.stringify(row), MAX_LENGTH, HEAD_LENGTH, false))) as {
    ids: number[];
    markers: number[];
    qtype: number;
  }[];
  const batch = items.length;
  const length = Math.ceil(Math.max(...items.map((x) => x.ids.length)) / 8) * 8;
  const count = Math.max(...items.map((x) => x.markers.length));
  const ids = new BigInt64Array(batch * length);
  const attention = new BigInt64Array(batch * length);
  const positions = new BigInt64Array(batch * count);
  const mask = new Uint8Array(batch * count);
  const qtype = new BigInt64Array(batch);
  items.forEach((item, i) => {
    item.ids.forEach((id, j) => {
      ids[i * length + j] = BigInt(id);
      attention[i * length + j] = 1n;
    });
    item.markers.forEach((pos, j) => {
      positions[i * count + j] = BigInt(pos);
      mask[i * count + j] = 1;
    });
    qtype[i] = BigInt(item.qtype);
  });
  const output = await session.run({
    input_ids: new ort.Tensor('int64', ids, [batch, length]),
    attention_mask: new ort.Tensor('int64', attention, [batch, length]),
    marker_pos: new ort.Tensor('int64', positions, [batch, count]),
    marker_mask: new ort.Tensor('bool', mask, [batch, count]),
    qtype: new ort.Tensor('int64', qtype, [batch]),
  });
  const values = (await output.logits.getData()) as Float32Array;
  return items.map((item, i) => Array.from(values.slice(i * count, i * count + item.markers.length)));
}

/** Rebuild the keep/drop options when focus rules toggle. Julia-1.5 is phrasing-
 *  sensitive: this pair — rule keywords as the keep option, an explicit
 *  games/entertainment enumeration as the drop side — scores every clearly
 *  technical page ≥ 0.66 P(keep) while GTA-SteamDB (0.435) and a pancake
 *  recipe (0.235) drop, probed 2026-11-25 across 18 real captures. Rule
 *  keywords survive here (unlike Julia-1, which needed static text) because
 *  1.5 is trained to follow user-supplied criteria. */
export function setFocusCriteria(topics: string[], keywords: string[]): void {
  if (topics.length === 0 && keywords.length === 0) {
    options = null;
    return;
  }
  const keep = keywords.length > 0 ? keywords.join(', ') : topics.join('; ').slice(0, 480);
  options = [
    `technical: ${keep}`,
    'non-technical: games, gaming, entertainment, cooking, recipes, shopping, sports, gossip',
  ];
}

/**
 * Early gate: returns null (fail-open / disabled) or per-page keep decisions.
 * Page text is truncated by the serializer to the model's budget.
 */
export async function earlyFilter(
  pages: { title: string | null; content: string }[]
): Promise<boolean[] | null> {
  const opts = options;
  if (!opts || pages.length === 0) return null;
  if (!(await ready())) return null;
  const keep: boolean[] = [];
  for (let i = 0; i < pages.length; i += CHUNK) {
    const chunk = pages.slice(i, i + CHUNK);
    const rows = chunk.map((p) => ({
      state: `${p.title ?? ''}\n\n${p.content}`,
      question: 'Which category fits this page?',
      options: opts,
    }));
    try {
      const scores = await logits(rows);
      scores.forEach((values) => {
        const peak = Math.max(...values);
        const weights = values.map((x) => Math.exp(x - peak));
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        keep.push(weights[0]! / total >= THRESHOLD);
      });
    } catch (err) {
      // fail-open for the whole chunk
      console.error('julia-1 inference failed (fail-open):', err instanceof Error ? err.message : err);
      chunk.forEach(() => keep.push(true));
    }
  }
  return keep;
}
