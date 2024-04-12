import * as rxjs from "rxjs"
import { PcmData } from "./types"

export function immediate<T>(func: () => T) {
  return func()
}

export function lazy<T>(func: () => T) {
  let value: T
  return () => value ?? (value = func())
}

export async function* iterateStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  }
  finally {
    reader.releaseLock()
  }
}

export async function fetchWithProgress(url: string, callback: (percent: number) => void) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) {
    throw new Error("Couldn't retrieve content-length");
  }
  if (!response.body) {
    throw new Error("No content")
  }

  const totalSize = parseInt(contentLength, 10);
  const chunks = [] as ArrayBuffer[]
  let loaded = 0;

  for await (const chunk of iterateStream(response.body)) {
    chunks.push(chunk)
    loaded += chunk.length;
    const progress = (loaded / totalSize) * 100;
    callback(progress);
  }

  return new Blob(chunks, {
    type: response.headers.get('content-type') || undefined
  })
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

export function makeBatchProcessor<T, V>(maxBatchSize: number, process: (items: T[]) => Promise<V[]>) {
  function makeBatch() {
    const items: T[] = []
    return {
      items,
      size: 0,
      process: lazy(() => process(items))
    }
  }
  let currentBatch: ReturnType<typeof makeBatch>|undefined
  return {
    add(item: T, itemSize: number): () => Promise<V> {
      const batch = (currentBatch && currentBatch.size + itemSize <= maxBatchSize) ? currentBatch : (currentBatch = makeBatch())
      const index = batch.items.length
      batch.items.push(item)
      batch.size += itemSize
      return () => batch.process().then(results => results[index])
    }
  }
}

export function makeWav(chunks: Array<{pcmData: PcmData, appendSilenceSeconds: number}>): Blob {
  const numChannels = chunks.length ? chunks[0].pcmData.numChannels : 2
  const sampleRate = chunks.length ? chunks[0].pcmData.sampleRate : 44100

  //normalize, convert, concatenate
  let numSamples = 0
  let peak = 0
  for (const {pcmData, appendSilenceSeconds} of chunks) {
    numSamples += pcmData.samples.length + (appendSilenceSeconds * pcmData.sampleRate * pcmData.numChannels)
    for (const s of pcmData.samples) {
      if (s > peak) peak = s
      else if (-s > peak) peak = -s
    }
  }

  const factor = 1 / Math.max(.01, peak)
  const samples = new Int16Array(numSamples)
  let offset = 0
  for (const {pcmData, appendSilenceSeconds} of chunks) {
    for (const s of pcmData.samples) {
      samples[offset++] = s * factor * (s < 0 ? 32768 : 32767)
    }
    offset += (appendSilenceSeconds * pcmData.sampleRate * pcmData.numChannels)
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
