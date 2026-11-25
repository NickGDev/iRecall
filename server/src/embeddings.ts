// Local embeddings via transformers.js (ONNX). Model: granite-embedding-small-
// english-r2 (IBM, ModernBERT, 47M params, 384 dims, 8192-token context) —
// retrieval-tuned, beats MiniLM/bge/e5-small on long-doc search. Cached under
// server/models — no cloud at runtime after first download.
//
// The ONNX graph emits `sentence_embedding` directly (no manual pooling), so we
// drive AutoModel+AutoTokenizer instead of the feature-extraction pipeline.
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
env.cacheDir = path.join(here, '..', 'models');
env.allowLocalModels = true;

export const EMBED_MODEL = 'granite-embedding-small-english-r2';
const MODEL_ID = 'onnx-community/granite-embedding-small-english-r2-ONNX';
export const EMBED_DIM = 384;

// Page content is embedded head-first. 12k chars ≈ 3k tokens: covers the vast
// majority of articles in full while keeping CPU cost per page bounded (ctx
// ceiling is 8192 tokens).
export const MAX_CHARS = 12_000;

type EmbeddedModel = (
  inputs: Record<string, unknown>
) => Promise<{ sentence_embedding: { normalize: () => { tolist: () => number[][] } } }>;

let model: EmbeddedModel | null = null;
let tokenizer: ((texts: string[], opts?: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;
let loading: Promise<void> | null = null;

async function loadModel(): Promise<void> {
  tokenizer = (await AutoTokenizer.from_pretrained(MODEL_ID)) as unknown as typeof tokenizer;
  model = (await AutoModel.from_pretrained(MODEL_ID, { dtype: 'fp32' })) as unknown as EmbeddedModel;
}

async function getModel(): Promise<{ tokenizer: NonNullable<typeof tokenizer>; model: EmbeddedModel }> {
  if (model && tokenizer) return { tokenizer, model };
  if (!loading) {
    loading = loadModel().catch((err) => {
      // Reset so the next call retries instead of awaiting the same rejected
      // promise for the rest of the process lifetime.
      loading = null;
      throw err;
    });
  }
  await loading;
  return { tokenizer: tokenizer!, model: model! };
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  const { tokenizer: tok, model: m } = await getModel();
  const inputs = await tok(
    texts.map((t) => t.slice(0, MAX_CHARS)),
    { padding: true, truncation: true, max_length: 8192 }
  );
  const out = await m(inputs);
  return out.sentence_embedding.normalize().tolist().map((vec) => new Float32Array(vec));
}

export async function embedOne(text: string): Promise<Float32Array> {
  return (await embed([text]))[0]!;
}
