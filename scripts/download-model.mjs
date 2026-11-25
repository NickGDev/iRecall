// Pre-warm the embedding model into server/models so the server runs offline.
// Uses the exact same load path as server/src/embeddings.ts (AutoModel), so a
// successful run here guarantees the runtime hits only local cache.
import { env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedOne, EMBED_MODEL, EMBED_DIM } from '../server/src/embeddings.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
env.cacheDir = path.join(root, 'server', 'models');

console.log(`downloading embedding model (${EMBED_MODEL}, ~130MB fp32)...`);
const vec = await embedOne('warmup: sqlite vector search');
if (vec.length !== EMBED_DIM) throw new Error(`dim mismatch: got ${vec.length}, want ${EMBED_DIM}`);
console.log(`model cached (${vec.length}-dim) ->`, env.cacheDir);
