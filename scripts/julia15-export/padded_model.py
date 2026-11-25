"""Julia-1.5 as a padded-batch torch module, exportable to ONNX.

Re-implements vendor runtime/julia15/engine.py math (packed ModernBERT + decision
head) in padded [B, T] form — same weights, same results, static shapes. Padded
keys are masked out of every attention; marker rows are gathered via marker_pos.
Ground truth: vendor fixtures reference.json.
Run: venv/bin/python padded_model.py   (torch parity, then export via --export)
"""

import json
import math
import struct
import sys
from pathlib import Path

import torch
import torch.nn.functional as F

CHECKPOINT = Path('/tmp/julia15')  # model.safetensors, encoder/config.json, julia_config.json
HEAD_DIM = 64


class Config:
    def __init__(self, root: Path):
        enc = json.loads((root / 'encoder' / 'config.json').read_text())
        self.hidden = self.H = enc['hidden_size']
        self.heads = enc['num_attention_heads']
        self.layers = enc['num_hidden_layers']
        self.eps = enc['layer_norm_eps']
        self.window = enc['local_attention'] // 2
        self.global_every = enc['global_attn_every_n_layers']
        rope = enc.get('rope_parameters') or {}
        self.theta_global = rope.get('full_attention', {}).get('rope_theta', 160000)
        self.theta_local = rope.get('sliding_attention', {}).get('rope_theta', 160000)
        self.head_layers = json.loads((root / 'julia_config.json').read_text())['head_layers']


def load_weights(path: Path) -> dict:
    with open(path, 'rb') as f:
        size = struct.unpack('<Q', f.read(8))[0]
        header = json.loads(f.read(size))
    header.pop('__metadata__', None)
    dtypes = {'F32': torch.float32, 'F16': torch.float16, 'BF16': torch.bfloat16, 'I64': torch.int64, 'I32': torch.int32}
    import os

    storage = torch.UntypedStorage.from_file(str(path), shared=False, nbytes=os.path.getsize(path))
    raw = torch.empty(0, dtype=torch.uint8).set_(storage)
    out = {}
    for key, meta in header.items():
        if key.startswith('act_head.'):
            continue
        a, b = meta['data_offsets']
        out[key] = raw[8 + size + a : 8 + size + b].view(dtypes[meta['dtype']]).view(meta['shape'])
    return out


def rope_tables(theta: float, length: int):
    inv = 1.0 / (theta ** (torch.arange(0, HEAD_DIM, 2, dtype=torch.float32) / HEAD_DIM))
    freqs = torch.outer(torch.arange(length, dtype=torch.float32), inv)
    emb = torch.cat((freqs, freqs), -1)
    return emb.cos(), emb.sin()


def rotate(x, cos, sin):
    half = HEAD_DIM // 2
    x1, x2 = x[..., :half], x[..., half:]
    return x * cos + torch.cat((-x2, x1), -1) * sin


class PaddedJulia(torch.nn.Module):
    """forward(input_ids[B,T], attention_mask[B,T], marker_pos[B,M], marker_mask[B,M], qtype[B]) -> logits[B,M]."""

    def __init__(self, root: Path):
        super().__init__()
        self.cfg = Config(root)
        self.theta_g = self.cfg.theta_global
        self.theta_l = self.cfg.theta_local
        self.w = load_weights(root / 'model.safetensors')

    def _w(self, name: str):
        return self.w[name]

    def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
        c = self.cfg
        B, T = input_ids.shape
        H = c.hidden
        M = marker_pos.shape[1]
        cos_g, sin_g = rope_tables(self.theta_g, T)
        cos_l, sin_l = (
            (cos_g, sin_g) if self.theta_l == self.theta_g else rope_tables(self.theta_l, T)
        )

        h = F.layer_norm(
            F.embedding(input_ids, self._w('encoder.embeddings.tok_embeddings.weight')).float(),
            (H,),
            self._w('encoder.embeddings.norm.weight'),
            None,
            c.eps,
        )
        # additive float masks: SDPA decomposes to scores + mask (Add), no
        # masked_fill Where over [B,heads,T,T] per layer (22.7% of runtime in v1)
        key_add = (1.0 - attention_mask.to(torch.float32))[:, None, None, :] * -1e9  # [B,1,1,T]
        off = (torch.arange(T)[:, None] - torch.arange(T)[None, :]).abs()  # [T,T]
        band_add = (off > c.window).to(torch.float32)[None, None, :, :] * -1e9  # [1,1,T,T]
        for i in range(c.layers):
            p = f'encoder.layers.{i}.'
            x = h if i == 0 else F.layer_norm(h, (H,), self._w(p + 'attn_norm.weight'), None, c.eps)
            qkv = F.linear(x, self._w(p + 'attn.Wqkv.weight')).view(B, T, 3, c.heads, HEAD_DIM)
            q, k, v = qkv.unbind(2)  # [B,T,heads,64]
            g = i % c.global_every == 0
            cos, sin = (cos_g, sin_g) if g else (cos_l, sin_l)
            cos, sin = cos[None, :, None, :], sin[None, :, None, :]  # [1,T,1,64]
            q, k = rotate(q, cos, sin), rotate(k, cos, sin)
            qh, kh, vh = (t.transpose(1, 2) for t in (q, k, v))  # [B,heads,T,64]
            mask = key_add if g else key_add + band_add
            att = F.scaled_dot_product_attention(qh, kh, vh, attn_mask=mask)
            att = att.transpose(1, 2).reshape(B, T, H)
            h = h + F.linear(att, self._w(p + 'attn.Wo.weight'))
            x = F.layer_norm(h, (H,), self._w(p + 'mlp_norm.weight'), None, c.eps)
            u, gate = F.linear(x, self._w(p + 'mlp.Wi.weight')).chunk(2, -1)
            h = h + F.linear(F.gelu(u) * gate, self._w(p + 'mlp.Wo.weight'))
        h = F.layer_norm(h, (H,), self._w('encoder.final_norm.weight'), None, c.eps)

        # decision head — fp32 throughout (head weights are fp32 in the checkpoint)
        h = h + self._w('type_emb.weight')[qtype][:, None, :]
        flat_pos = (marker_pos * marker_mask).reshape(-1)  # [B*M]
        seq_index = torch.arange(B, device=h.device)[:, None].expand(B, M).reshape(-1)
        flat_rows = seq_index * T + flat_pos  # [B*M] row into [B*T]
        amask_flat = attention_mask.reshape(-1)
        for i in range(c.head_layers):
            p = f'head.layers.{i}.'
            last = i == c.head_layers - 1
            x = F.layer_norm(h, (H,), self._w(p + 'norm1.weight'), self._w(p + 'norm1.bias'), 1e-5)
            win = self._w(p + 'self_attn.in_proj_weight')
            bin_ = self._w(p + 'self_attn.in_proj_bias')
            if not last:
                qkv = F.linear(x, win, bin_).view(B, T, 3, c.heads, HEAD_DIM)
                q, k, v = qkv.unbind(2)
                qh, kh, vh = (t.transpose(1, 2) for t in (q, k, v))
                att = F.scaled_dot_product_attention(qh, kh, vh, attn_mask=key_add)
                att = att.transpose(1, 2).reshape(B, T, H)
                h = h + F.linear(att, self._w(p + 'self_attn.out_proj.weight'), self._w(p + 'self_attn.out_proj.bias'))
            else:
                kv = F.linear(x, win[H:], bin_[H:]).view(B, T, 2, c.heads, HEAD_DIM)
                k, v = kv.unbind(2)
                kh, vh = (t.transpose(1, 2) for t in (k, v))  # [B,heads,T,64]
                # each marker query attends its own sequence's keys (vendor
                # head_attention query_rows path), masks via that row's key_valid
                k_rows = kh[seq_index]  # [B*M, heads, T, 64]
                v_rows = vh[seq_index]
                q = F.linear(x.reshape(-1, H)[flat_rows], win[:H], bin_[:H]).view(-1, c.heads, 1, HEAD_DIM)
                att = F.scaled_dot_product_attention(q, k_rows, v_rows, attn_mask=key_add[seq_index])
                att = att.reshape(-1, H)
                h = h.reshape(-1, H)[flat_rows] + F.linear(
                    att, self._w(p + 'self_attn.out_proj.weight'), self._w(p + 'self_attn.out_proj.bias')
                )
            x = F.layer_norm(h, (H,), self._w(p + 'norm2.weight'), self._w(p + 'norm2.bias'), 1e-5)
            h = h + F.linear(
                F.relu(F.linear(x, self._w(p + 'linear1.weight'), self._w(p + 'linear1.bias'))),
                self._w(p + 'linear2.weight'),
                self._w(p + 'linear2.bias'),
            )
        x = F.layer_norm(h, (H,), self._w('scorer.0.weight'), self._w('scorer.0.bias'), 1e-5)
        x = F.gelu(F.linear(x, self._w('scorer.1.weight'), self._w('scorer.1.bias')))
        scores = F.linear(x, self._w('scorer.3.weight'), self._w('scorer.3.bias')).squeeze(-1).float()
        per_marker_qtype = qtype[:, None].expand(B, M).reshape(-1)
        scores = scores / self._w('temperature')[per_marker_qtype]
        return (scores * marker_mask.reshape(-1)).reshape(B, M)


def main():
    root = CHECKPOINT
    model = PaddedJuliaV2(root).eval()
    sys.path.insert(0, str(root / 'runtime'))
    from julia15.encoding import Encoder
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(root / 'tokenizer' / 'tokenizer.json'))
    enc = Encoder(tok, max_length=1024, head_length=512, strict=False)
    ref = json.loads((root / 'runtime' / 'tests' / 'fixtures' / 'reference.json').read_text())
    items = [enc.encode(row) for row in ref['rows']]
    length = max(len(x['ids']) for x in items)
    count = max(len(x['markers']) for x in items)
    ids = torch.zeros(len(items), length, dtype=torch.int64)
    amask = torch.zeros(len(items), length, dtype=torch.int64)
    mpos = torch.zeros(len(items), count, dtype=torch.int64)
    mmask = torch.zeros(len(items), count, dtype=torch.bool)
    qtype = torch.zeros(len(items), dtype=torch.int64)
    for i, x in enumerate(items):
        ids[i, : len(x['ids'])] = torch.tensor(x['ids'])
        amask[i, : len(x['ids'])] = 1
        mpos[i, : len(x['markers'])] = torch.tensor(x['markers'])
        mmask[i, : len(x['markers'])] = 1
        qtype[i] = x['qtype']
    with torch.inference_mode():
        got = model(ids, amask, mpos, mmask, qtype)
    for i, x in enumerate(items):
        exp = ref['logits']['julia-1.5/core'][i]
        n = len(x['markers'])
        g = got[i, :n].tolist()
        err = max(abs(a - b) for a, b in zip(exp, g))
        print(f'row {i}: expected={exp} got={[round(v, 4) for v in g]} max_err={err:.5f}')
        assert err < 5e-3, f'parity failed row {i}'
    print('torch parity: PASS')


if __name__ == '__main__':
    main()
