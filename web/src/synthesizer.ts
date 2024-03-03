import * as ort from "onnxruntime-web"
import * as rxjs from "rxjs"
import config from "./config"
import { makePhonemizer } from "./phonemizer"
import { playAudio } from "./player"
import { ModelConfig, PcmData, SpeakOptions, Speech, Synthesizer } from "./types"

ort.env.wasm.numThreads = navigator.hardwareConcurrency


export async function makeSynthesizer(model: Blob, modelConfig: ModelConfig): Promise<Synthesizer> {
  const phonemizer = makePhonemizer(modelConfig)
  const engine = await makeInferenceEngine(model, modelConfig)

  async function play(
    {speakerId, utterance, pitch, rate, volume}: SpeakOptions,
    control: rxjs.BehaviorSubject<"play"|"pause"|"stop">,
    onCanPlay: () => void
  ) {
    const phrases = await phonemizer.phonemize(utterance)
    let prefetch: Promise<PcmData>|undefined
    for (let index = 0; index < phrases.length && control.getValue() != "stop"; index++) {
      const pcmData = await (prefetch || engine.infer(phrases[index].phonemeIds, speakerId))
      if (index == 0) onCanPlay()
      if (index+1 < phrases.length) {
        const nextPhonemeIds = phrases[index+1].phonemeIds
        prefetch = new Promise(f => setTimeout(f))
          .then(() => engine.infer(nextPhonemeIds, speakerId))
      }
      await playAudio(pcmData, phrases[index].silenceSeconds, pitch, rate, volume, control)
    }
  }

  return {
    makeSpeech(opts): Speech {
      const control = new rxjs.BehaviorSubject<"play"|"pause"|"stop">("pause")
      const canPlaySubject = new rxjs.Subject<void>()
      const canPlayPromise = rxjs.firstValueFrom(canPlaySubject)
      const finishPromise = play(opts, control, () => canPlaySubject.next())
      return {
        control,
        readyPromise: Promise.race([canPlayPromise, finishPromise]),
        finishPromise
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
    async infer(phonemeIds: number[], speakerId: number|undefined): Promise<PcmData> {
      const feeds: Record<string, ort.Tensor> = {
        input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
        input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
        scales: new ort.Tensor('float32', [noiseScale, lengthScale, noiseW])
      }
      if (speakerId != undefined) feeds.sid = new ort.Tensor('int64', [speakerId])
      const start = Date.now()
      const {output} = await session.run(feeds)
      console.debug("Synthesized in", Date.now()-start, "ms", phonemeIds)
      return {
        samples: output.data as Float32Array,
        sampleRate,
        numChannels
      }
    }
  }
}
