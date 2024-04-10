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

export function makePcmConcatenator() {
  const chunks = [] as {pcmData: PcmData, appendSilenceSamples: number}[]
  return {
    add(pcmData: PcmData, appendSilenceSeconds: number) {
      chunks.push({
        pcmData,
        appendSilenceSamples: appendSilenceSeconds * pcmData.sampleRate * pcmData.numChannels
      })
    },
    get(): PcmData|null {
      if (chunks.length) {
        const numSamples = chunks.reduce((sum, chunk) => sum + chunk.pcmData.samples.length + chunk.appendSilenceSamples, 0)
        const samples = new Float32Array(numSamples)
        let offset = 0
        for (const chunk of chunks) {
          samples.set(chunk.pcmData.samples, offset)
          offset += chunk.pcmData.samples.length + chunk.appendSilenceSamples
        }
        return {
          numChannels: chunks[0].pcmData.numChannels,
          sampleRate: chunks[0].pcmData.sampleRate,
          samples
        }
      }
      else {
        return null
      }
    }
  }
}
