import * as rxjs from "rxjs"
import { PcmData, ModelSettings } from "./types"

export function immediate<T>(func: () => T) {
  return func()
}

export function lazy<T>(func: () => T) {
  let value: T
  return () => value ?? (value = func())
}

export function wait<T>(obs: rxjs.Observable<T>, value: T) {
  return rxjs.firstValueFrom(obs.pipe(rxjs.filter(x => x == value)))
}

export function makeExposedPromise<T>() {
  const exposed = {} as {
    promise: Promise<T>
    fulfill(value: T): void
    reject(reason: unknown): void
  }
  exposed.promise = new Promise((fulfill, reject) => {
    exposed.fulfill = fulfill
    exposed.reject = reject
  })
  return exposed
}

export function makeWav(_chunks: Array<{pcmData: PcmData, appendSilenceSeconds: number}>): Blob {
  const chunks = _chunks.map(({pcmData, appendSilenceSeconds}) => ({
    pcmData,
    appendSilenceSamples: Math.floor(appendSilenceSeconds * pcmData.sampleRate * pcmData.numChannels) >> 1 << 1
  }))
  const numChannels = chunks.length ? chunks[0].pcmData.numChannels : 2
  const sampleRate = chunks.length ? chunks[0].pcmData.sampleRate : 44100

  //normalize, convert, concatenate
  let numSamples = 0
  let peak = 0
  for (const {pcmData, appendSilenceSamples} of chunks) {
    numSamples += pcmData.samples.length + appendSilenceSamples
    for (const s of pcmData.samples) {
      if (s > peak) peak = s
      else if (-s > peak) peak = -s
    }
  }

  const factor = 1 / Math.max(.01, peak)
  const samples = new Int16Array(numSamples)
  let offset = 0
  for (const {pcmData, appendSilenceSamples} of chunks) {
    for (const s of pcmData.samples) {
      samples[offset++] = s * factor * (s < 0 ? 32768 : 32767)
    }
    offset += appendSilenceSamples
  }

  //WAV header
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numSamples * blockAlign

  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  function writeString(offset: number, string: string) {
    for (let i = 0; i < string.length; i++)
      view.setUint8(offset + i, string.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, dataSize + 36, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  //WAV blob
  return new Blob([header, samples], {type: "audio/wav"})
}

const SETTINGS_KEY = 'kokoro-model-settings'

export function getModelSettings(): ModelSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // Fall through to defaults
  }
  return { quantization: 'fp32', device: 'webgpu' }
}

export function setModelSettings(settings: ModelSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Silently fail if localStorage is unavailable
  }
}
