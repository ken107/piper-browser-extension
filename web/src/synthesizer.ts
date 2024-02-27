import * as ort from "onnxruntime-web"
import * as rxjs from "rxjs"
import config from "./config"
import { ModelConfig, SpeakOptions, Speech, Synthesizer } from "./types"

ort.env.wasm.numThreads = navigator.hardwareConcurrency


//from: piper/src/cpp/piper.hpp
const defaults = {
  phonemeType: "espeak",
  sampleRate: 22050,
  channels: 1,
  noiseScale: 0.667,
  lengthScale: 1,
  noiseW: 0.8,
  sentenceSilenceSeconds: .2,
} as const


//from: piper-phonemize/src/phoneme_ids.hpp
const phonemeIdConfig = {
  pad: '_',
  bos: '^',
  eos: '$',

  // Every other phoneme id is pad
  interspersePad: true,

  // Add beginning of sentence (bos) symbol at start
  addBos: true,

  // Add end of sentence (eos) symbol at end
  addEos: true,
} as const



export async function createSynthesizer(model: Blob, modelConfig: ModelConfig): Promise<Synthesizer> {
  switch (modelConfig.phoneme_type ?? defaults.phonemeType) {
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
  const sampleRate = modelConfig.audio?.sample_rate ?? defaults.sampleRate
  const numChannels = defaults.channels
  const noiseScale = modelConfig.inference?.noise_scale ?? defaults.noiseScale
  const lengthScale = modelConfig.inference?.length_scale ?? defaults.lengthScale
  const noiseW = modelConfig.inference?.noise_w ?? defaults.noiseW
  const sentenceSilenceSeconds = defaults.sentenceSilenceSeconds

  const sentences = await phonemize(utterance, modelConfig)
  const audioPlayer = makeAudioPlayer(sampleRate, numChannels)
  const playback = rxjs.from(sentences)
    .pipe(
      rxjs.concatMap(async phonemes => {
        //TODO: handle phoneme_silence
        const phonemeIds = toPhonemeIds(phonemes, modelConfig)
        const start = Date.now()
        const {output} = await session.run({
          input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
          input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
          scales: new ort.Tensor('float32', [noiseScale, lengthScale, noiseW])
        })
        console.debug("Synthesized in", Date.now()-start, "ms", phonemes, phonemeIds)
        await audioPlayer.play(output.data as Float32Array, sentenceSilenceSeconds)
      })
    )
  let subscription: rxjs.Subscription
  const finishPromise = new Promise<void>((f,r) => subscription = playback.subscribe({complete: f, error: r}))
  finishPromise.finally(() => audioPlayer.close())
  return {
    async pause() {
      //TODO: must be made into a state machine to handle intermediate loading states
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
  if (!modelConfig.espeak?.voice) throw new Error("Missing modelConfig.espeak.voice")
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


//from: piper-phonemize/src/phoneme_ids.cpp
function toPhonemeIds(phonemes: string[], modelConfig: ModelConfig): number[] {
  if (!modelConfig.phoneme_id_map) throw new Error("Missing modelConfig.phoneme_id_map")
  const missing = new Set<string>()
  const phonemeIds = [] as number[]
  if (phonemeIdConfig.addBos) {
    phonemeIds.push(...modelConfig.phoneme_id_map[phonemeIdConfig.bos])
    if (phonemeIdConfig.interspersePad)
      phonemeIds.push(...modelConfig.phoneme_id_map[phonemeIdConfig.pad])
  }
  for (const phoneme of phonemes) {
    const mapping = modelConfig.phoneme_id_map[phoneme]
    if (!mapping) {
      missing.add(phoneme)
      continue
    }
    phonemeIds.push(...mapping)
    if (phonemeIdConfig.interspersePad)
      phonemeIds.push(...modelConfig.phoneme_id_map[phonemeIdConfig.pad])
  }
  if (phonemeIdConfig.addEos) {
    phonemeIds.push(...modelConfig.phoneme_id_map[phonemeIdConfig.eos])
  }
  if (missing.size) console.warn("Missing mapping for phonemes", missing)
  return phonemeIds
}


function makeAudioPlayer(sampleRate: number, numChannels: number) {
  const audioCtx = new window.AudioContext({sampleRate})
  return {
    play(pcmData: Float32Array, appendSilenceSeconds: number) {
      const {buffer, peak} = makeAudioBuffer(pcmData, appendSilenceSeconds)
      const source = audioCtx.createBufferSource()
      source.buffer = buffer
      const gainNode = audioCtx.createGain()
      gainNode.gain.value = 1 / Math.max(.01, peak)
      source.connect(gainNode)
      gainNode.connect(audioCtx.destination)
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
  function makeAudioBuffer(pcmData: Float32Array, appendSilenceSeconds: number): {buffer: AudioBuffer, peak: number} {
    const samplesPerChannel = pcmData.length / numChannels
    const buffer = audioCtx.createBuffer(numChannels, samplesPerChannel + (appendSilenceSeconds * sampleRate), sampleRate)
    let peak = 0
    for (let channel = 0; channel < numChannels; channel++) {
      const nowBuffering = buffer.getChannelData(channel)
      for (let i = 0; i < samplesPerChannel; i++) {
        const sample = pcmData[i * numChannels + channel]   //assuming interleaved channel data
        nowBuffering[i] = sample
        if (sample > peak) peak = sample
        else if (-sample > peak) peak = -sample
      }
    }
    return {buffer, peak}
  }
}
