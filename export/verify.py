#!/usr/bin/env python3
"""Check an exported bundle against the reference pocket-tts model, and optionally against
another bundle (e.g. KevinAHM's), by generating the same text deterministically (no sampling
noise) with each and comparing the latents and audio.

    python verify.py bundles/english_2026-04 [--int8] [--against DIR] [--against-int8]

The ONNX side runs the same loop as web/src/pocket.ts.
"""

import argparse
import json
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
import sentencepiece

TEXT = "Hello world. This is a quick check that the exported model matches the original one."
FRAMES = 60
DECODE_FRAMES = 12
CLIP_URL = "https://huggingface.co/kyutai/tts-voices/resolve/main/alba-mackenna/casual.wav"


def tokens_for(bundle_dir):
    sp = sentencepiece.SentencePieceProcessor(model_file=str(bundle_dir / "tokenizer.model"))
    return np.array([sp.encode(TEXT)], dtype=np.int64)


def run_onnx(bundle_dir, int8):
    bundle_dir = Path(bundle_dir)
    meta = json.loads((bundle_dir / "bundle.json").read_text())
    suffix = "_int8" if int8 else ""
    session = lambda name: ort.InferenceSession(str(bundle_dir / f"{name}{suffix}.onnx"), providers=["CPUExecutionProvider"])
    conditioner, main, flow, decoder = (session(n) for n in ["text_conditioner", "flow_lm_main", "flow_lm_flow", "mimi_decoder"])

    def init_state(manifest):
        state = {}
        for e in manifest:
            dtype = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}[e["dtype"]]
            fill = {"nan": np.nan, "ones": 1}.get(e["fill"], 0)
            state[e["input_name"]] = np.full(e["shape"], fill, dtype=dtype)
        return state

    def update(state, outputs, names, manifest):
        result = dict(zip(names, outputs))
        for e in manifest:
            state[e["input_name"]] = result[e["output_name"]]
        return result

    main_names = [o.name for o in main.get_outputs()]
    ldim, dim = meta["latent_dim"], meta["conditioning_dim"]
    flow_state = init_state(meta["flow_lm_state_manifest"])
    text_emb = conditioner.run(None, {"token_ids": tokens_for(bundle_dir)})[0]
    if text_emb.ndim == 2:
        text_emb = text_emb[None]
    update(flow_state, main.run(None, {"sequence": np.zeros((1, 0, ldim), np.float32), "text_embeddings": text_emb, **flow_state}),
           main_names, meta["flow_lm_state_manifest"])

    latents = []
    current = np.full((1, 1, ldim), np.nan, np.float32)
    for _ in range(FRAMES):
        out = update(flow_state, main.run(None, {"sequence": current, "text_embeddings": np.zeros((1, 0, dim), np.float32), **flow_state}),
                     main_names, meta["flow_lm_state_manifest"])
        noise = np.zeros((1, ldim), np.float32)
        if meta.get("flow_type", "lsd") == "drifting":
            latent = flow.run(None, {"c": out["conditioning"], "x": noise})[0]
        else:
            latent = noise + flow.run(None, {"c": out["conditioning"], "s": np.zeros((1, 1), np.float32),
                                             "t": np.ones((1, 1), np.float32), "x": noise})[0]
        latents.append(latent[0])
        current = latent[None].astype(np.float32)

    decoder_names = [o.name for o in decoder.get_outputs()]
    mimi_state = init_state(meta["mimi_state_manifest"])
    audio = []
    for start in range(0, FRAMES, DECODE_FRAMES):
        batch = np.stack(latents[start : start + DECODE_FRAMES])[None].astype(np.float32)
        out = update(mimi_state, decoder.run(None, {"latent": batch, **mimi_state}), decoder_names, meta["mimi_state_manifest"])
        audio.append(out[decoder_names[0]].reshape(-1))
    return np.stack(latents), np.concatenate(audio)


def run_reference(model):
    import torch
    from pocket_tts import TTSModel
    from pocket_tts.modules.stateful_module import increment_steps, init_states

    tts = TTSModel.load_model(language=model, temp=0.0).cpu().eval()
    hop = int(tts.mimi.encoder_frame_rate / tts.mimi.frame_rate)
    with torch.no_grad():
        state = init_states(tts.flow_lm, batch_size=1, sequence_length=1000)
        tts._run_flow_lm_and_increment_step(state, text_tokens=tts.flow_lm.conditioner.prepare(TEXT))
        latents = []
        current = torch.full((1, 1, tts.flow_lm.ldim), float("nan"))
        for _ in range(FRAMES):
            current, _ = tts._run_flow_lm_and_increment_step(state, backbone_input_latents=current)
            latents.append(current[0, 0].numpy())
        latents = np.stack(latents)

        mimi_state = init_states(tts.mimi, batch_size=1, sequence_length=FRAMES * hop)
        audio = []
        for start in range(0, FRAMES, DECODE_FRAMES):
            batch = torch.from_numpy(latents[None, start : start + DECODE_FRAMES])
            audio.append(tts.mimi.decode_from_latent(batch * tts.flow_lm.emb_std + tts.flow_lm.emb_mean, mimi_state).reshape(-1).numpy())
            increment_steps(tts.mimi, mimi_state, increment=hop * batch.shape[1])
        return latents, np.concatenate(audio), tts


def check_encoder(bundle_dir, int8, tts):
    import io
    import torch
    import soundfile
    from scipy.signal import resample_poly

    wav, sr = soundfile.read(io.BytesIO(urllib.request.urlopen(CLIP_URL).read()), dtype="float32")
    wav = resample_poly(wav, 24000, sr).astype(np.float32)
    frame = int(tts.mimi.sample_rate / tts.mimi.frame_rate)
    wav = np.pad(wav, (0, -len(wav) % frame))[None, None]
    with torch.no_grad():
        reference = torch.nn.functional.linear(tts.mimi.encode_to_latent(torch.from_numpy(wav)), tts.flow_lm.speaker_proj_weight).numpy()
    suffix = "_int8" if int8 else ""
    encoder = ort.InferenceSession(str(Path(bundle_dir) / f"mimi_encoder{suffix}.onnx"), providers=["CPUExecutionProvider"])
    return reference, encoder.run(None, {"audio": wav})[0]


def report(name, a, b):
    rel = np.linalg.norm(a - b) / np.linalg.norm(b)
    print(f"  {name:<22} relative error {rel:.2e}   max abs diff {np.abs(a - b).max():.2e}")
    return rel


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bundle", help="exported bundle directory")
    parser.add_argument("--int8", action="store_true", help="check the _int8 models")
    parser.add_argument("--against", help="another bundle directory to compare with, instead of the reference model")
    parser.add_argument("--against-int8", action="store_true", help="use the other bundle's _int8 models")
    args = parser.parse_args()

    bundle = Path(args.bundle)
    meta = json.loads((bundle / "bundle.json").read_text())
    latents, audio = run_onnx(bundle, args.int8)
    if args.against:
        print(f"{bundle.name}{' int8' if args.int8 else ''} vs {args.against}{' int8' if args.against_int8 else ''}:")
        other_latents, other_audio = run_onnx(args.against, args.against_int8)
        report("latents", latents, other_latents)
        report("audio", audio[: len(other_audio)], other_audio[: len(audio)])
        return

    print(f"{bundle.name}{' int8' if args.int8 else ''} vs the reference model:")
    ref_latents, ref_audio, tts = run_reference(meta["bundle_name"])
    report("latents", latents, ref_latents)
    report("audio", audio, ref_audio)
    if meta.get("has_voice_cloning", True):
        report("voice encoder", *check_encoder(bundle, args.int8, tts))
    else:
        print("  voice encoder          skipped, exported without voice cloning")


if __name__ == "__main__":
    main()
