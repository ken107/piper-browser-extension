import { makeStateMachine } from "@lsdsoftware/state-machine"
import * as ort from "onnxruntime-web"
import * as rxjs from "rxjs"
import config from "./config"
import { ModelConfig, SpeakOptions, Speech, Synthesizer } from "./types"
import { immediate } from "./utils"

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
  const session = await ort.InferenceSession.create(URL.createObjectURL(model))
  return {
    isBusy: false,
    makeSpeech(opts) {
      return makeSpeech(session, modelConfig, opts)
    }
  }
}


async function makeSpeech(session: ort.InferenceSession, modelConfig: ModelConfig, {speakerId, utterance, pitch, rate, volume}: SpeakOptions): Promise<Speech> {
  const sampleRate = modelConfig.audio?.sample_rate ?? defaults.sampleRate
  const numChannels = defaults.channels
  const noiseScale = modelConfig.inference?.noise_scale ?? defaults.noiseScale
  const lengthScale = modelConfig.inference?.length_scale ?? defaults.lengthScale
  const noiseW = modelConfig.inference?.noise_w ?? defaults.noiseW
  const sentenceSilenceSeconds = defaults.sentenceSilenceSeconds

  const sentences = await phonemize(utterance, modelConfig)
  const audioPlayer = makeAudioPlayer(sampleRate, numChannels)
  const readySubject = new rxjs.Subject<void>()
  const readyPromise = rxjs.firstValueFrom(readySubject, {defaultValue: undefined as void})
  const finishSubject = new rxjs.Subject<void>()
  const finishPromise = rxjs.firstValueFrom(finishSubject, {defaultValue: undefined as void})
  finishPromise.finally(() => audioPlayer.close())

  async function synthesize(phonemes: string[]): Promise<Float32Array> {
    //TODO: handle phoneme_silence
    const phonemeIds = toPhonemeIds(phonemes, modelConfig)
    const start = Date.now()
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('int64', phonemeIds, [1, phonemeIds.length]),
      input_lengths: new ort.Tensor('int64', [phonemeIds.length]),
      scales: new ort.Tensor('float32', [noiseScale, lengthScale, noiseW])
    }
    if (speakerId != undefined) feeds.sid = new ort.Tensor('int64', [speakerId])
    const {output} = await session.run(feeds)
    console.debug("Synthesized in", Date.now()-start, "ms", phonemes, phonemeIds)
    return output.data as Float32Array
  }

  let index = 0
  const hasNext = () => index +1 < sentences.length
  const sm = makeStateMachine({
    IDLE: {
      load() {
        if (index < sentences.length) {
          synthesize(sentences[index])
            .then(pcmData => {
              readySubject.complete()
              sm.trigger("onSynthesized", pcmData)
            }, err => {
              readySubject.error(err)
              sm.trigger("onError", err)
            })
          return "SYNTHESIZING_PAUSED"
        }
        else {
          readySubject.complete()
          finishSubject.complete()
          return "DONE"
        }
      }
    },
    SYNTHESIZING: {
      onSynthesized(pcmData: Float32Array) {
        audioPlayer.play(pcmData, hasNext() ? sentenceSilenceSeconds : 0).then(() => sm.trigger("onEnded"))
        return "PLAYING"
      },
      onError(err: unknown) {
        finishSubject.error(err)
        return "DONE"
      },
      pause() {
        return "SYNTHESIZING_PAUSED"
      },
      resume() {},
      stop() {
        finishSubject.error(new Error("interrupted"))
        return "DONE"
      }
    },
    SYNTHESIZING_PAUSED: {
      onTransitionIn(this: {pcmData?: Float32Array}) {
        this.pcmData = undefined
      },
      onSynthesized(this: {pcmData?: Float32Array}, pcmData: Float32Array) {
        this.pcmData = pcmData
      },
      onError(err: unknown) {
        finishSubject.error(err)
        return "DONE"
      },
      pause() {},
      resume(this: {pcmData?: Float32Array}) {
        if (this.pcmData) {
          audioPlayer.play(this.pcmData, hasNext() ? sentenceSilenceSeconds : 0).then(() => sm.trigger("onEnded"))
          return "PLAYING"
        }
        else {
          return "SYNTHESIZING"
        }
      },
      stop() {
        finishSubject.error(new Error("interrupted"))
        return "DONE"
      }
    },
    PLAYING: {
      onTransitionIn(this: {prefetch: Promise<Float32Array>}) {
        if (hasNext()) this.prefetch = synthesize(sentences[index +1])
      },
      pause() {
        audioPlayer.pause()
      },
      resume() {
        audioPlayer.resume()
      },
      onEnded(this: {prefetch: Promise<Float32Array>}) {
        if (hasNext()) {
          index++
          this.prefetch
            .then(
              pcmData => sm.trigger("onSynthesized", pcmData),
              err => sm.trigger("onError", err)
            )
          return "SYNTHESIZING"
        }
        else {
          finishSubject.complete()
          return "DONE"
        }
      },
      stop() {
        finishSubject.error(new Error("interrupted"))
        return "DONE"
      }
    },
    DONE: {
      onSynthesized() {},
      onError() {},
      onEnded() {},
      pause() {},
      resume() {},
      stop() {}
    }
  })

  sm.trigger("load")
  await readyPromise

  return {
    play() {
      sm.trigger("resume")
    },
    pause() {
      sm.trigger("pause")
    },
    stop() {
      sm.trigger("stop")
    },
    finishPromise
  }
}


async function phonemize(text: string, modelConfig: ModelConfig): Promise<string[][]> {
  const phonemeType = (modelConfig.phoneme_type ?? defaults.phonemeType) == "text" ? "text" : "espeak"
  const res = await fetch(config.serviceUrl + "/phonemizer?capabilities=phonemize-1.0", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      method: "phonemize",
      type: phonemeType,
      text,
      lang: immediate(() => {
        if (phonemeType == "espeak") {
          if (!modelConfig.espeak?.voice) throw new Error("Missing modelConfig.espeak.voice")
          return modelConfig.espeak.voice
        }
        else {
          return "ignore"
        }
      })
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
    pause() {
      audioCtx.suspend().catch(console.error)
    },
    resume() {
      audioCtx.resume().catch(console.error)
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
