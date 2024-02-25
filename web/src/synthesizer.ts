import * as ort from "onnxruntime-web"
import * as rxjs from "rxjs"
import config from "./config"
import { ModelConfig, SpeakOptions, Speech, Synthesizer } from "./types"

ort.env.wasm.numThreads = navigator.hardwareConcurrency


export async function createSynthesizer(model: Blob, modelConfig: ModelConfig): Promise<Synthesizer> {
  switch (modelConfig.phoneme_type) {
    case undefined:
    case "espeak":
      break
    default:
      throw new Error("Unsupported phoneme_type " + modelConfig.phoneme_type)
  }
  const session = await ort.InferenceSession.create(URL.createObjectURL(model))
  return {
    isBusy: false,
    speak(opts) {
      return speak(session, modelConfig, opts)
    }
  }
}


async function speak(session: ort.InferenceSession, modelConfig: ModelConfig, {utterance, pitch, rate, volume}: SpeakOptions): Promise<Speech> {
  const sentences = await phonemize(utterance, modelConfig)
  const audioPlayer = makeAudioPlayer(modelConfig.audio.sample_rate, 1)
  const playback = rxjs.from(sentences)
    .pipe(
      rxjs.concatMap(async phonemes => {
        const phonemeIds = toPhonemeIds(phonemes, modelConfig)
        const start = Date.now()
        const {output} = await session.run({
          input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
          input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
          scales: new ort.Tensor('float32', [
            modelConfig.inference.noise_scale,
            modelConfig.inference.length_scale,
            modelConfig.inference.noise_w
          ])
        })
        console.debug("Synthesized in", Date.now()-start, "ms", phonemes, phonemeIds)
        await audioPlayer.play(output.data as Float32Array)
      })
    )
  let subscription: rxjs.Subscription
  const finishPromise = new Promise<void>((f,r) => subscription = playback.subscribe({complete: f, error: r}))
  finishPromise.finally(() => audioPlayer.close())
  return {
    async pause() {
      await audioPlayer.pause()
    },
    async resume() {
      await audioPlayer.resume()
    },
    async stop() {
      await audioPlayer.pause()
      subscription.unsubscribe()
    },
    wait() {
      return finishPromise
    }
  }
}


async function phonemize(text: string, modelConfig: ModelConfig): Promise<string[][]> {
  const res = await fetch(config.serviceUrl + "/phonemizer?capabilities=phonemize-1.0", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      method: "phonemize",
      text,
      lang: modelConfig.espeak.voice
    })
  })
  if (!res.ok) throw new Error("Server return " + res.status)
  const result = await res.json() as {text: string, phonemes: string[][]}
  if (result.text != text) throw new Error("Unexpected")
  return result.phonemes
}


function toPhonemeIds(phonemes: string[], modelConfig: ModelConfig): number[] {
  const missing = [] as string[]
  const phonemeIds = [] as number[]
  for (const phoneme of phonemes) {
    const mapping = modelConfig.phoneme_id_map[phoneme]
    if (mapping) phonemeIds.push(...mapping)
    else missing.push(phoneme)
  }
  if (missing.length) console.warn("Missing mapping for phonemes", missing)
  return phonemeIds
}


function makeAudioPlayer(sampleRate: number, numChannels: number) {
  const audioCtx = new window.AudioContext({sampleRate})
  return {
    play(pcmData: Float32Array) {
      const source = audioCtx.createBufferSource()
      source.buffer = makeAudioBuffer(pcmData)
      source.connect(audioCtx.destination)
      return new Promise(f => {
        source.onended = f
        source.start()
      })
    },
    async pause() {
      await audioCtx.suspend()
    },
    async resume() {
      await audioCtx.resume()
    },
    close() {
      audioCtx.close().catch(console.error)
    }
  }
  function makeAudioBuffer(pcmData: Float32Array) {
    const buffer = audioCtx.createBuffer(numChannels, pcmData.length / numChannels, sampleRate)
    for (let channel = 0; channel < numChannels; channel++) {
      const nowBuffering = buffer.getChannelData(channel)
      for (let i = 0; i < pcmData.length / numChannels; i++) {
        nowBuffering[i] = pcmData[i * numChannels + channel]
      }
    }
    return buffer
  }
}
