import * as rxjs from "rxjs"
import { PcmData } from "./types"

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

export function printFileSize(bytes: number) {
  if (bytes < 0) return '0 B'
  if (bytes < 1_000) return bytes + ' B'
  if (bytes >= 1_000_000) {
    const mb = bytes / 1_000_000
    return mb.toPrecision(3) + ' MB'
  }
  const kb = bytes / 1_000
  return kb.toPrecision(3) + ' KB'
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${value}`);
}

export function makeMutex() {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    runExclusive<T>(task: () => Promise<T>) {
      const nextTask = queue.then(task)
      queue = nextTask.catch(() => {})
      return nextTask
    }
  }
}
