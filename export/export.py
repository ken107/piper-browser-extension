#!/usr/bin/env python3
"""Export a Kyutai Pocket TTS model to the ONNX bundle the web page loads.

    python export.py english_18m_2026-10 [--out DIR] [--no-quantize] [--allow-no-voice-cloning]

Writes DIR/<model>/ with bundle.json, tokenizer.model, bos_before_voice.npy and the
text_conditioner, flow_lm_main, flow_lm_flow, mimi_decoder, mimi_encoder models (fp32 and
_int8). See README.md.

Adapted from https://github.com/lomotron/pocket-tts-onnx-export (MIT), which produced
KevinAHM's bundles, and ported to the current pocket-tts code (pinned in requirements.txt).
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
import torch.nn as nn
import torch.nn.functional as F
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.quantization.shape_inference import quant_pre_process

import pocket_tts.models.mimi
from pocket_tts import TTSModel
from pocket_tts.default_parameters import MAX_TOKEN_PER_CHUNK
from pocket_tts.modules.attention import StreamingMultiheadAttention
from pocket_tts.modules.stateful_module import init_states
from pocket_tts.utils.utils import download_if_necessary

#the flow LM keeps a linear KV cache over the whole conditioning + generation of one chunk
FLOW_CACHE_LEN = 1000
#torch.arange of a traced length is baked in by the TorchScript exporter, slicing a constant
#arange by it is not
MAX_POSITIONS = 16384
#the page runs the mimi decoder on up to this many latent frames per call
MAX_DECODE_FRAMES = 12
#extra frames generated after EOS, and EOS ignored at the start, as TTSModel does
FRAMES_AFTER_EOS_OFFSET = 2
MIN_FRAMES_BEFORE_EOS = TTSModel._MIN_FRAMES_BEFORE_EOS


# ------------------------------------------------------------------------------------------
# Export-friendly attention: the offset stays a tensor (upstream reads it with .item(), which
# tracing would freeze), the flow LM writes its linear cache with a dynamic slice, and mimi's
# attention, which only looks `context` steps back, keeps a sliding window of that size
# instead of a cache as long as the whole generation.

def _positions(n):
    return torch.arange(MAX_POSITIONS)[:n]


def _init_state(self, batch_size, sequence_length):
    dtype = self.in_proj.weight.dtype
    shape = (2, batch_size, sequence_length if self.context is None else self.context, self.num_kv_heads, self.dim_per_head)
    return dict(
        offset=torch.zeros(1, dtype=torch.long),
        #window slots that haven't been written yet must be finite, they are masked but still multiplied
        cache=torch.full(shape, float("nan"), dtype=dtype) if self.context is None else torch.zeros(shape, dtype=dtype),
    )


def _increment_step(self, state, increment=1):
    #the wrappers advance the offsets themselves, with traced increments
    pass


def _forward(self, query, model_state, attn_mask=None):
    state = None if model_state is None else self.get_state(model_state)
    projected = self.in_proj(query)
    b, t, _ = projected.shape
    d = self.dim_per_head
    q = projected[..., : self.attn_dim].view(b, t, self.num_heads, d)
    kv = projected[..., self.attn_dim :].view(b, t, 2, self.num_kv_heads, d)
    k, v = torch.unbind(kv, dim=2)

    offset = torch.zeros((), dtype=torch.long) if state is None else state["offset"][0]
    q, k = self.rope(q, k, offset=offset)
    pos_q = offset + _positions(t)

    if state is None:
        keys, values, pos_k = k, v, pos_q
    elif self.context is None:
        cache = state["cache"].clone()
        cache[:, :, offset : offset + t] = torch.stack([k, v])
        state["cache"] = cache
        #slice before splitting k from v, splitting first copies the whole cache every step
        keys, values = cache[:, :, : offset + t].unbind(0)
        pos_k = _positions(offset + t)
    else:
        window = self.context
        keys = torch.cat([state["cache"][0], k], dim=1)
        values = torch.cat([state["cache"][1], v], dim=1)
        state["cache"] = torch.stack([keys[:, -window:], values[:, -window:]])
        pos_k = offset - window + _positions(window + t)

    delta = pos_q[:, None] - pos_k[None, :]
    mask = (pos_k[None, :] >= 0) & (delta >= 0)
    if self.context is not None:
        mask = mask & (delta < self.context)

    keys = keys.permute(0, 2, 1, 3)
    values = values.permute(0, 2, 1, 3)
    if self.num_kv_heads != self.num_heads:
        keys = keys.repeat_interleave(self.num_heads // self.num_kv_heads, dim=1)
        values = values.repeat_interleave(self.num_heads // self.num_kv_heads, dim=1)
    x = F.scaled_dot_product_attention(q.transpose(1, 2), keys, values, mask)
    x = x.transpose(1, 2).reshape(b, t, self.num_heads * d)
    return self.out_proj(x)


def patch_attention():
    StreamingMultiheadAttention.init_state = _init_state
    StreamingMultiheadAttention.increment_step = _increment_step
    StreamingMultiheadAttention.forward = _forward
    #the encoder pads its input to whole frames with a length computed in Python, which tracing
    #would freeze to the dummy input's; the page pads clips to whole frames instead
    pocket_tts.models.mimi.pad_for_conv1d = lambda x, kernel_size, stride, padding_total=0: x


# ------------------------------------------------------------------------------------------
# State (de)serialization: one flat ONNX input/output per tensor, in manifest order

def state_entries(state):
    return [(module, key) for module in sorted(state) for key in sorted(state[module])]


def unflatten(entries, flat):
    state = {}
    for (module, key), tensor in zip(entries, flat):
        #clone, in-place updates of graph inputs don't export
        state.setdefault(module, {})[key] = tensor.clone()
    return state


def flatten(entries, state):
    return [state[module][key] for module, key in entries]


def advance(state, increment):
    for module_state in state.values():
        if "offset" in module_state:
            module_state["offset"] = module_state["offset"] + increment


def build_manifest(entries, state):
    manifest = []
    for index, (module, key) in enumerate(entries):
        tensor = state[module][key]
        if tensor.numel() == 0:
            fill = "empty"
        elif tensor.dtype.is_floating_point and torch.isnan(tensor).all():
            fill = "nan"
        elif torch.all(tensor == 0):
            fill = "zeros"
        elif torch.all(tensor == 1):
            fill = "ones"
        else:
            raise ValueError(f"Initial state {module}/{key} can't be described by a fill")
        manifest.append(dict(
            index=index, module=module, key=key, path=f"{module}/{key}",
            dtype=str(tensor.dtype).removeprefix("torch."), shape=list(tensor.shape), fill=fill,
            input_name=f"state_{index}", output_name=f"out_state_{index}",
        ))
    return manifest


# ------------------------------------------------------------------------------------------
# Wrappers, with the input/output names web/src/pocket.ts uses

class TextConditioner(nn.Module):
    def __init__(self, tts):
        super().__init__()
        self.conditioner = tts.flow_lm.conditioner

    def forward(self, token_ids):
        return self.conditioner(token_ids)


class FlowLmMain(nn.Module):
    """Backbone step. Conditioning: empty sequence + text (or voice) embeddings. Generation: one
    latent (NaN for BOS) + empty embeddings. Returns the flow head's conditioning and EOS logit
    for the last position (meaningless when conditioning), and the updated state."""

    def __init__(self, tts, entries):
        super().__init__()
        self.flow_lm = tts.flow_lm
        self.entries = entries

    def forward(self, sequence, text_embeddings, *flat_state):
        state = unflatten(self.entries, flat_state)
        sequence_or_bos = torch.where(torch.isnan(sequence), self.flow_lm.bos_emb, sequence)
        out = self.flow_lm.backbone(self.flow_lm.input_linear(sequence_or_bos), text_embeddings, sequence, model_state=state)
        #pad so there's a position to read when the sequence is empty
        out = torch.cat([out, torch.zeros_like(out[:, :1])], dim=1)
        conditioning = out[:, 0].to(torch.float32)
        eos_logit = self.flow_lm.out_eos(conditioning)
        advance(state, sequence.shape[1] + text_embeddings.shape[1])
        return (conditioning, eos_logit, *flatten(self.entries, state))


class LsdFlow(nn.Module):
    """One LSD step from time s to t: the page integrates x += flow_dir / steps."""

    def __init__(self, tts):
        super().__init__()
        self.flow_net = tts.flow_lm.flow_net

    def forward(self, c, s, t, x):
        return self.flow_net(c, s, t, x)


class DriftingFlow(nn.Module):
    """One-step head: maps the noise straight to the latent."""

    def __init__(self, tts):
        super().__init__()
        self.flow_net = tts.flow_lm.flow_net

    def forward(self, c, x):
        return self.flow_net(c, x)


class MimiDecoder(nn.Module):
    def __init__(self, tts, entries):
        super().__init__()
        self.mimi = tts.mimi
        self.entries = entries
        self.register_buffer("emb_std", tts.flow_lm.emb_std.clone())
        self.register_buffer("emb_mean", tts.flow_lm.emb_mean.clone())
        self.hop = int(tts.mimi.encoder_frame_rate / tts.mimi.frame_rate)

    def forward(self, latent, *flat_state):
        state = unflatten(self.entries, flat_state)
        audio = self.mimi.decode_from_latent(latent * self.emb_std + self.emb_mean, state)
        advance(state, latent.shape[1] * self.hop)
        return (audio, *flatten(self.entries, state))


class MimiEncoder(nn.Module):
    """Voice clip (length a multiple of samples_per_frame) to the voice conditioning embedding,
    without bos_before_voice, which the page prepends."""

    def __init__(self, tts):
        super().__init__()
        self.mimi = tts.mimi
        self.register_buffer("speaker_proj_weight", tts.flow_lm.speaker_proj_weight.detach().clone())

    def forward(self, audio):
        return F.linear(self.mimi.encode_to_latent(audio), self.speaker_proj_weight)


# ------------------------------------------------------------------------------------------

def export(module, args, path, input_names, output_names, dynamic_axes):
    with torch.no_grad():
        torch.onnx.export(
            module, args, str(path), input_names=input_names, output_names=output_names,
            dynamic_axes=dynamic_axes, opset_version=17, dynamo=False,
        )
    onnx.checker.check_model(str(path))
    print(f"  {path.name} ({path.stat().st_size / 1e6:.1f} MB)")


def quantize(path):
    path = path.resolve()
    out = path.with_name(path.stem + "_int8.onnx")
    #fold the exporter's Identity nodes first, otherwise the quantizer misses weights behind them
    #(symbolic shape inference can't follow the KV cache's dynamic slices); both steps write
    #temporary files to the working directory, so run them in a temporary one
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        try:
            preprocessed = Path(tmp) / "preprocessed.onnx"
            quant_pre_process(str(path), str(preprocessed), skip_symbolic_shape=True)
            #MatMul only, dynamic int8 weights, as KevinAHM's bundles
            quantize_dynamic(
                model_input=str(preprocessed), model_output=str(out), weight_type=QuantType.QInt8,
                op_types_to_quantize=["MatMul"], extra_options={"ForceQuantizeNoType": True, "DefaultTensorType": 1},
            )
        finally:
            os.chdir(cwd)
    print(f"  {out.name} ({out.stat().st_size / 1e6:.1f} MB)")


def copy_tokenizer(tts, out_dir):
    #the page tokenizes with sentencepiece; configs may point at the equivalent tokenizer.json
    path = str(tts.config.flow_lm.lookup_table.tokenizer_path)
    base, _, revision = path.partition("@")
    if base.endswith(".json"):
        base = base[: -len("tokenizer.json")] + "tokenizer.model"
    shutil.copyfile(download_if_necessary(base + ("@" + revision if revision else "")), out_dir / "tokenizer.model")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", help="Kyutai model name, e.g. english_18m_2026-10")
    parser.add_argument("--out", default="bundles", help="output directory (default: bundles)")
    parser.add_argument("--no-quantize", action="store_true", help="skip the _int8 models")
    parser.add_argument("--allow-no-voice-cloning", action="store_true",
                        help="export from the ungated weights; mimi_encoder will be useless (for testing)")
    args = parser.parse_args()

    patch_attention()
    torch.manual_seed(0)
    tts = TTSModel.load_model(language=args.model).cpu().eval()
    if not getattr(tts, "has_voice_cloning", True) and not args.allow_no_voice_cloning:
        sys.exit("Could not download the gated weights with voice cloning. Accept the terms at "
                 "https://huggingface.co/kyutai/pocket-tts and run `hf auth login`, see README.md.")

    out_dir = Path(args.out) / args.model
    out_dir.mkdir(parents=True, exist_ok=True)
    config = tts.config
    flow_lm, mimi = tts.flow_lm, tts.mimi
    print(f"Exporting {args.model} to {out_dir}")

    export(TextConditioner(tts), (torch.zeros(1, 5, dtype=torch.long),), out_dir / "text_conditioner.onnx",
           ["token_ids"], ["embeddings"], {"token_ids": {1: "tokens"}})

    flow_state = init_states(flow_lm, batch_size=1, sequence_length=FLOW_CACHE_LEN)
    flow_entries = state_entries(flow_state)
    flow_names = [f"state_{i}" for i in range(len(flow_entries))]
    export(FlowLmMain(tts, flow_entries),
           (torch.randn(1, 1, flow_lm.ldim), torch.randn(1, 3, flow_lm.dim), *flatten(flow_entries, flow_state)),
           out_dir / "flow_lm_main.onnx",
           ["sequence", "text_embeddings", *flow_names], ["conditioning", "eos_logit", *("out_" + n for n in flow_names)],
           {"sequence": {1: "sequence_length"}, "text_embeddings": {1: "text_length"}})

    cond_dim = flow_lm.z_proj.out_features if flow_lm.z_proj is not None else flow_lm.dim
    if flow_lm.flow_type == "lsd":
        export(LsdFlow(tts), (torch.randn(1, cond_dim), torch.zeros(1, 1), torch.ones(1, 1), torch.randn(1, flow_lm.ldim)),
               out_dir / "flow_lm_flow.onnx", ["c", "s", "t", "x"], ["flow_dir"], None)
    elif flow_lm.flow_type == "drifting":
        export(DriftingFlow(tts), (torch.randn(1, cond_dim), torch.randn(1, flow_lm.ldim)),
               out_dir / "flow_lm_flow.onnx", ["c", "x"], ["latent"], None)
    else:
        sys.exit(f"Unsupported flow type: {flow_lm.flow_type}")

    mimi_state = init_states(mimi, batch_size=1, sequence_length=0)
    mimi_entries = state_entries(mimi_state)
    mimi_names = [f"state_{i}" for i in range(len(mimi_entries))]
    export(MimiDecoder(tts, mimi_entries),
           (torch.randn(1, MAX_DECODE_FRAMES, flow_lm.ldim), *flatten(mimi_entries, mimi_state)),
           out_dir / "mimi_decoder.onnx",
           ["latent", *mimi_names], ["audio", *("out_" + n for n in mimi_names)],
           {"latent": {1: "frames"}, "audio": {2: "samples"}})

    samples_per_frame = int(round(config.mimi.sample_rate / config.mimi.frame_rate))
    export(MimiEncoder(tts), (torch.randn(1, 1, 10 * samples_per_frame),), out_dir / "mimi_encoder.onnx",
           ["audio"], ["latents"], {"audio": {2: "samples"}, "latents": {1: "frames"}})

    copy_tokenizer(tts, out_dir)
    if flow_lm.insert_bos_before_voice:
        np.save(out_dir / "bos_before_voice.npy", flow_lm.bos_before_voice.detach().numpy())

    bundle = dict(
        schema_version=3,
        bundle_name=args.model,
        language=args.model,
        sample_rate=config.mimi.sample_rate,
        frame_rate=config.mimi.frame_rate,
        samples_per_frame=samples_per_frame,
        latent_dim=flow_lm.ldim,
        conditioning_dim=flow_lm.dim,
        flow_type=flow_lm.flow_type,
        default_temperature=config.default_temperature,
        default_eos_threshold=config.default_eos_threshold,
        min_frames_before_eos=MIN_FRAMES_BEFORE_EOS,
        frames_after_eos_offset=FRAMES_AFTER_EOS_OFFSET,
        model_recommended_frames_after_eos=config.model_recommended_frames_after_eos,
        max_token_per_chunk=MAX_TOKEN_PER_CHUNK,
        max_decode_frames=MAX_DECODE_FRAMES,
        pad_with_spaces_for_short_inputs=tts.pad_with_spaces_for_short_inputs,
        remove_semicolons=tts.remove_semicolons,
        replace_characters=dict(config.replace_characters),
        insert_bos_before_voice=bool(flow_lm.insert_bos_before_voice),
        bos_before_voice_file="bos_before_voice.npy" if flow_lm.insert_bos_before_voice else None,
        tokenizer_file="tokenizer.model",
        has_voice_cloning=bool(getattr(tts, "has_voice_cloning", True)),
        flow_lm_state_manifest=build_manifest(flow_entries, flow_state),
        mimi_state_manifest=build_manifest(mimi_entries, mimi_state),
    )
    (out_dir / "bundle.json").write_text(json.dumps(bundle, indent=2) + "\n")

    if not args.no_quantize:
        print("Quantizing")
        for name in ["text_conditioner", "flow_lm_main", "flow_lm_flow", "mimi_decoder", "mimi_encoder"]:
            quantize(out_dir / f"{name}.onnx")
    print("Done")


if __name__ == "__main__":
    main()
