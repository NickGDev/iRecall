"""Export PaddedJulia to ONNX (padded batch contract, same names as Julia-1-ONNX)
and verify the exported graph through onnxruntime against vendor reference.json.
Run: venv/bin/python export_and_check.py
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch
import onnxruntime as ort

sys.path.insert(0, '/tmp/julia15-export')
from padded_model import PaddedJulia, CHECKPOINT

OUT = Path('/tmp/julia15/model.onnx')


def build_inputs():
    sys.path.insert(0, str(CHECKPOINT / 'runtime'))
    from julia15.encoding import Encoder
    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(CHECKPOINT / 'tokenizer' / 'tokenizer.json'))
    enc = Encoder(tok, max_length=1024, head_length=512, strict=False)
    ref = json.loads((CHECKPOINT / 'runtime' / 'tests' / 'fixtures' / 'reference.json').read_text())
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
    return items, ref, (ids, amask, mpos, mmask, qtype)


def main():
    model = PaddedJulia(CHECKPOINT).eval()
    items, ref, tensors = build_inputs()
    ids, amask, mpos, mmask, qtype = tensors
    with torch.inference_mode():
        torch_got = model(ids, amask, mpos, mmask, qtype)

    torch.onnx.export(
        model,
        tensors,
        str(OUT),
        input_names=['input_ids', 'attention_mask', 'marker_pos', 'marker_mask', 'qtype'],
        output_names=['logits'],
        dynamic_axes={
            'input_ids': {0: 'batch', 1: 'tokens'},
            'attention_mask': {0: 'batch', 1: 'tokens'},
            'marker_pos': {0: 'batch', 1: 'options'},
            'marker_mask': {0: 'batch', 1: 'options'},
            'qtype': {0: 'batch'},
            'logits': {0: 'batch', 1: 'options'},
        },
        dynamo=True,
        external_data=True,
    )
    print('exported', OUT)

    session = ort.InferenceSession(str(OUT), providers=['CPUExecutionProvider'])
    feed = {
        'input_ids': ids.numpy(),
        'attention_mask': amask.numpy(),
        'marker_pos': mpos.numpy(),
        'marker_mask': mmask.numpy(),
        'qtype': qtype.numpy(),
    }
    out = session.run(['logits'], feed)[0]
    max_err = 0.0
    ok = True
    for i, x in enumerate(items):
        exp = ref['logits']['julia-1.5/core'][i]
        n = len(x['markers'])
        g = out[i, :n].tolist()
        err = max(abs(a - b) for a, b in zip(exp, g))
        max_err = max(max_err, err)
        match = all(abs(a - b) < 5e-3 for a, b in zip(exp, g))
        ok &= match
        print(f'row {i}: max_err={err:.5f} {"ok" if match else "MISMATCH"} exp={exp} got={[round(v, 4) for v in g]}')
    torch_err = max(
        abs(a - b)
        for i, x in enumerate(items)
        for a, b in zip(ref['logits']['julia-1.5/core'][i], torch_got[i, : len(x['markers'])].tolist())
    )
    print(f'torch max_err={torch_err:.5f} | ort max_err={max_err:.5f} | {"PARITY PASS" if ok else "PARITY FAIL"}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
