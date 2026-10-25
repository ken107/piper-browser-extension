# Pocket TTS → ONNX export

Exports a [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) model to the ONNX bundle
that the web page (`web/src/pocket.ts`) loads. Adapted from
[lomotron/pocket-tts-onnx-export](https://github.com/lomotron/pocket-tts-onnx-export) (MIT), which
produced [KevinAHM's bundles](https://huggingface.co/KevinAHM/pocket-tts-onnx), and ported to the
current pocket-tts code, which also covers the newer models (e.g. the small `english_18m_2026-10`).

## Setup

Python 3.12+ (tested with 3.14).

```bash
cd export
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

The weights with voice cloning, which the page needs (it clones every voice from a clip), are gated:

1. Sign in at https://huggingface.co/kyutai/pocket-tts and accept the terms.
2. Create a Read token at https://huggingface.co/settings/tokens (it starts with `hf_`).
3. `.venv/bin/hf auth login` and paste it.

## Export

```bash
.venv/bin/python export.py english_18m_2026-10
```

The model name is any config in pocket-tts's `pocket_tts/config/` (`english_2026-04`,
`english_18m_2026-10`, `french`, ...). Output goes to `bundles/<model>/` (ignored by git):

| file | |
|---|---|
| `bundle.json` | metadata and the state manifests the page uses to build the model state |
| `tokenizer.model` | SentencePiece tokenizer |
| `bos_before_voice.npy` | embedding prepended to the voice conditioning |
| `text_conditioner[_int8].onnx` | token ids → text embeddings |
| `flow_lm_main[_int8].onnx` | transformer step: conditioning, or one latent frame → flow conditioning, EOS logit |
| `flow_lm_flow[_int8].onnx` | flow head: noise → latent (LSD: one step `c,s,t,x → flow_dir`; drifting: `c,x → latent`) |
| `mimi_decoder[_int8].onnx` | latent frames → audio, streaming |
| `mimi_encoder[_int8].onnx` | voice clip (whole frames, 24 kHz mono) → voice conditioning |

The page loads the `_int8` files; `--no-quantize` skips them. To try a bundle, host the
directory and point the worker's `repoPath` at it (`config.pocketRepoPath` for the page).

## Verify

```bash
.venv/bin/python verify.py bundles/english_18m_2026-10 [--int8]
.venv/bin/python verify.py bundles/english_2026-04 --int8 --against <KevinAHM bundle dir> --against-int8
```

Generates the same text without sampling noise with the ONNX models (the same loop as the page)
and with pocket-tts itself, and compares the latents, the audio, and the voice encoder output.
The fp32 models match to ~1e-6. The int8 ones drift from the reference over the generated frames,
as KevinAHM's do, by the same amount.

## How it differs from lomotron's exporter

- It patches the current pocket-tts, pinned in `requirements.txt`, instead of vendoring an older
  copy: the attention keeps its position offset as a tensor (pocket-tts reads it with `.item()`,
  which tracing would freeze), the flow LM writes its linear KV cache with a dynamic slice, and
  mimi's attention, which only looks `context` steps back, keeps a sliding window of that size.
- It exports the drifting flow head of the newer models, a single step with no timesteps.
- `bundle.json` carries the model's sampling settings (`flow_type`, `default_temperature`,
  `default_eos_threshold`, `min_frames_before_eos`, `frames_after_eos_offset`,
  `replace_characters`); the page falls back to KevinAHM's defaults for bundles without them.
- The encoder takes audio already padded to whole frames (the page pads it), since the padding
  pocket-tts computes would be frozen to the traced length.
- No `voices.bin`, the page encodes voice clips itself.
