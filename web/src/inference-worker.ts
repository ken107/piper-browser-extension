import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as ort from "onnxruntime-web"
import config from "./config"
import { loadPocketTts, PocketTts } from "./pocket"
import { PcmData } from "./types"
import { makeMutex } from "./utils"

ort.env.wasm.numThreads = navigator.hardwareConcurrency > 2
  ? navigator.hardwareConcurrency - 1
  : navigator.hardwareConcurrency;

ort.env.wasm.wasmPaths = config.ortWasmPaths

console.info('Using', ort.env.wasm.numThreads, 'of', navigator.hardwareConcurrency, 'threads')


class TransferableResult {
  constructor(public result: unknown, public transfer: Transferable[]) {}
}

const dispatcher = makeDispatcher("pocket-worker", {initialize, addVoice, infer, dispose})

addEventListener("message", event => {
  //console.debug(event.data)
  dispatcher.dispatch(event.data, null, res => {
    if (res.result instanceof TransferableResult) {
      const {result, transfer} = res.result
      res.result = result
      //console.debug(res, transfer)
      postMessage(res, {transfer})
    }
    else {
      //console.debug(res)
      postMessage(res)
    }
  })
})


let engine: PocketTts | undefined
const mutex = makeMutex()

async function initialize(args: Record<string, unknown>) {
  if (engine) {
    throw new Error('Already initialized')
  }

  const repoPath = typeof args.repoPath == 'string' ? args.repoPath : config.pocketRepoPath

  engine = await loadPocketTts(repoPath, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  })

  return {
    sampleRate: engine.sampleRate,
    numThreads: ort.env.wasm.numThreads,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: self.crossOriginIsolated
  }
}

async function addVoice(args: Record<string, unknown>) {
  if (!engine) {
    throw new Error('Not initialized')
  }

  const { voiceId, clip } = args
  if (typeof voiceId != 'string' || !(clip instanceof Float32Array)) {
    throw new Error('Bad args')
  }

  //the encoder shares the model sessions with synthesis, which can't run concurrently
  await mutex.runExclusive(() => engine!.addVoice(voiceId, clip))
}

async function infer(args: Record<string, unknown>) {
  if (!engine) {
    throw new Error('Not initialized')
  }

  const { text, voiceId, numSteps } = args
  if (typeof text != 'string'
    || typeof voiceId != 'string'
    || typeof numSteps != 'number') {
    throw new Error('Bad args')
  }

  //time only the synthesis itself, not the wait for the mutex
  const { samples, synthMs } = await mutex.runExclusive(async () => {
    const start = performance.now()
    const samples = await engine!.synthesize(text, voiceId, numSteps)
    return { samples, synthMs: performance.now() - start }
  })
  const pcmData: PcmData & { synthMs: number } = {
    samples,
    sampleRate: engine.sampleRate,
    numChannels: 1,
    synthMs
  }
  return new TransferableResult(pcmData, [pcmData.samples.buffer])
}

async function dispose(args: Record<string, unknown>) {
  if (!engine) {
    throw new Error('Not initialized')
  }

  const results = await engine.dispose()
  if (results.some(x => x.status == 'rejected')) {
    console.error('Fail to dispose', results)
  }
  engine = undefined
}
