"""Dynamic int8 quantization of the deployed julia-1.5 ONNX export.

Runs directly on the exported graph (no torch / no checkpoint needed):
reads server/models/julia-1.5/model.onnx (+ external data) and writes
server/models/julia-1.5-fp16/model.onnx. QUInt8 weights per ORT's BERT
guidance; MatMul/Gemm/Attention only — LayerNorm/softmax untouched.
Parity gate is verdict-level: scripts/julia15-ab.ts must show the fp32
and q8 sessions agreeing on real captures before q8 ships.
"""

import os

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic

SRC = "server/models/julia-1.5/model.onnx"
DST = "server/models/julia-1.5-fp16/model.onnx"

model = onnx.load(SRC, load_external_data=True)
# Quantized graph is self-contained — strip external-data references so ORT
# doesn't go looking for model.onnx_data next to the q8 output.
for tensor in model.graph.initializer:
    if tensor.HasField("data_location") and tensor.data_location == onnx.TensorProto.EXTERNAL:
        tensor.data_location = onnx.TensorProto.DEFAULT
        tensor.ClearField("external_data")
        tensor.ClearField("data_location")
onnx.save(model, DST + ".unquantized.prep")

# VERDICT 2026-11-25: int8 matmul quantization is REJECTED for this model —
# the A/B probe (scripts/julia15-ab.ts) showed 57% verdict agreement and 7
# hard flips on real captures: julia lives at the 0.5 threshold by design and
# quantization noise swamps it (also ~13% slower per page at these dims).
# Enabled only if you want to re-run the experiment.
QUANT_MATMUL = os.environ.get("JULIA_QUANT_MATMUL") == "1"

if QUANT_MATMUL:
    quantize_dynamic(
        DST + ".unquantized.prep",
        DST,
        weight_type=QuantType.QUInt8,
        per_channel=True,
        op_types_to_quantize=["MatMul", "Gemm", "Attention"],
    )
else:
    onnx.save(model, DST)
os.remove(DST + ".unquantized.prep")

# The dynamic quantizer can't touch the vocab embedding table (consumed by
# Gather, not MatMul) — on julia-1.5 that tensor is 393MB fp32, over half the
# model. Cast it to fp16 in place and re-insert an fp32 Cast after the Gather
# so downstream math stays fp32. Storage: 393MB -> ~197MB.
import numpy as np
from onnx import TensorProto, numpy_helper

m = onnx.load(DST)
table = None
for t in m.graph.initializer:
    if t.data_type == TensorProto.FLOAT and len(t.dims) and int(np.prod(t.dims)) * 4 > 100_000_000:
        table = t
        break
if table is not None:
    fp16 = numpy_helper.from_array(numpy_helper.to_array(table).astype(np.float16), table.name)
    m.graph.initializer.remove(table)
    m.graph.initializer.append(fp16)
    for n in list(m.graph.node):
        if table.name in n.input:
            out = n.output[0]
            cast = onnx.helper.make_node(
                "Cast", [out], [out + "_f32"], to=TensorProto.FLOAT, name=out + "_cast_fp16"
            )
            idx = list(m.graph.node).index(n)
            m.graph.node.insert(idx + 1, cast)
            for n2 in m.graph.node:
                if n2.name != cast.name:
                    n2.input[:] = [out + "_f32" if i == out else i for i in n2.input]
    # stale value_info may pin the old dtypes — ORT re-infers without it
    del m.graph.value_info[:]
    # Keep the external-data layout: mmap'd weights mean the OS pages them in
    # on demand and purges them under memory pressure. Single-file (embedded)
    # ONNX is read into the heap instead — measured 506MB resident vs 205MB.
    onnx.save(
        m,
        DST,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location="model.onnx.data",
        convert_attribute=False,
    )
    print("fp16 embedding table ->", DST)
else:
    print("no large fp32 table found, graph unchanged")
print("quantized ->", DST)
