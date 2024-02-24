import * as ort from "onnxruntime-web"
import { ModelConfig, Synthesizer } from "./types"
import config from "./config"

ort.env.wasm.numThreads = navigator.hardwareConcurrency


export function createSynthesizer(model: Blob, modelConfig: ModelConfig): Synthesizer {
  switch (modelConfig.phoneme_type) {
    case undefined:
    case "espeak":
      break
    default:
      throw new Error("Unsupported phoneme_type " + modelConfig.phoneme_type)
  }
  const session = ort.InferenceSession.create(URL.createObjectURL(model))
  return {
    isBusy: false,
    async speak({utterance, pitch, rate, volume}) {
      console.log("Speaking", {pitch, rate, volume}, utterance)
      const phonemes = await phonemize(utterance, modelConfig)
      const phonemeIds = toPhonemeIds(phonemes, modelConfig)
      const endPromise = new Promise<void>(f => setTimeout(f, 6000))
      return {
        async pause() {
          throw new Error("Not impl")
        },
        async resume() {
          throw new Error("Not impl")
        },
        async stop() {
          throw new Error("Not impl")
        },
        wait() {
          return endPromise
        }
      }
    }
  }
}


async function phonemize(text: string, modelConfig: ModelConfig) {
  const res = await fetch(config.serviceUrl + "/phonemize?capabilities=phonemize-1.0", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      method: "phonemize",
      text,
      lang: modelConfig.espeak.voice
    })
  })
  if (!res.ok) throw new Error("Server return " + res.status)
  const result = await res.json() as {
    text: string
    phonemes: string[][]
  }
  if (result.text != text) throw new Error("Unexpected")
  return result.phonemes
}


function toPhonemeIds(phonemes: string[][], modelConfig: ModelConfig): number[][] {
  const missing = [] as string[]
  const phonemeIds = phonemes
    .map(sentence => {
      const ids = [] as number[]
      for (const phoneme of sentence) {
        const mapping = modelConfig.phoneme_id_map[phoneme]
        if (mapping) ids.push(mapping[0])
        else missing.push(phoneme)
      }
      return ids
    })
    .filter(x => x.length)

  if (missing.length) console.warn("Missing mapping for phonemes", missing)
  return phonemeIds
}
