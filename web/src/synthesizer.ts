import * as ort from "onnxruntime-web"
import config from "./config"
import { makePhonemizer } from "./phonemizer"
import { playAudio } from "./player"
import { ModelConfig, PcmData, Synthesizer } from "./types"

ort.env.wasm.numThreads = (navigator.hardwareConcurrency > 2) ? (navigator.hardwareConcurrency - 1) : navigator.hardwareConcurrency


export async function makeSynthesizer(model: Blob, modelConfig: ModelConfig): Promise<Synthesizer> {
  const phonemizer = makePhonemizer(modelConfig)
  const engine = await makeInferenceEngine(model, modelConfig)

  async function synthesize(
    {phonemes, phonemeIds}: {phonemes: string[], phonemeIds: number[]},
    speakerId: number|undefined
  ) {
    const start = Date.now()
    try {
      return await engine.infer(phonemeIds, speakerId)
    }
    finally {
      console.debug("Synthesized", phonemes.length, "in", Date.now()-start, phonemes.join(""))
    }
  }

  return {
    async speak({speakerId, utterance, pitch, rate, volume}, control, {onSentenceBoundary}) {
      const phrases = await phonemizer.phonemize(utterance)
      if (control.getState() == "stop") throw {name: "interrupted", message: "Playback interrupted"}

      const prefetch = new Array<Promise<PcmData>|undefined>(phrases.length)
      for (let index = 0; index < phrases.length; index++) {
        const pcmData = await (prefetch[index] || (prefetch[index] = synthesize(phrases[index], speakerId)))
        if (await control.wait(state => state != "pause") == "stop") throw {name: "interrupted", message: "Playback interrupted"}

        let numPhonemesToPrefetch = 50
        for (let i = index + 1; i < phrases.length && numPhonemesToPrefetch > 0; i++) {
          const phrase = phrases[i]
          if (!prefetch[i]) {
            prefetch[i] = prefetch[i-1]!
              .then(() => new Promise(f => setTimeout(f)))
              .then(() => {
                if (control.getState() == "stop") throw {name: "interrupted", message: "Prefetch interrupted"}
                return synthesize(phrase, speakerId)
              })
          }
          numPhonemesToPrefetch -= phrase.phonemes.length
        }

        await playAudio(pcmData, phrases[index].silenceSeconds, pitch, rate, volume, control)
        if (control.getState() == "stop") throw {name: "interrupted", message: "Playback interrupted"}
      }
    }
  }
}


async function makeInferenceEngine(model: Blob, modelConfig: ModelConfig) {
  const sampleRate = modelConfig.audio?.sample_rate ?? config.defaults.sampleRate
  const numChannels = config.defaults.numChannels
  const noiseScale = modelConfig.inference?.noise_scale ?? config.defaults.noiseScale
  const lengthScale = modelConfig.inference?.length_scale ?? config.defaults.lengthScale
  const noiseW = modelConfig.inference?.noise_w ?? config.defaults.noiseW

  const session = await ort.InferenceSession.create(URL.createObjectURL(model))

  return {
    async infer(phonemeIds: readonly number[], speakerId: number|undefined): Promise<PcmData> {
      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
        input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
        scales: new ort.Tensor('float32', [noiseScale, lengthScale, noiseW])
      }
      if (speakerId != undefined) feeds.sid = new ort.Tensor('int64', [speakerId])
      const {output} = await session.run(feeds)
      return {
        samples: output.data as Float32Array,
        sampleRate,
        numChannels
      }
    }
  }
}
