import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as ort from "onnxruntime-web"
import config from "./config"
import { loadTextToSpeech, loadVoiceStyle, Style, TextToSpeech } from "./supertonic"
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

const dispatcher = makeDispatcher("supertonic-worker", {initialize, infer, dispose})

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


const voiceStyles = new Map<string, Promise<Style>>()

function getVoiceStyle(voiceId: string) {
  let promise = voiceStyles.get(voiceId)
  if (!promise) {
    const voice = config.voiceList.find(voice => voice.id == voiceId)
    if (!voice) {
      throw new Error('Voice not found')
    }
    voiceStyles.set(voiceId, promise = loadVoiceStyle([voice.stylePath]))
  }
  return promise
}


let engine: { textToSpeech: TextToSpeech, cfgs: any } | undefined
const mutex = makeMutex()

async function initialize(args: Record<string, unknown>) {
  if (engine) {
    throw new Error('Already initialized')
  }

  engine = await loadTextToSpeech(config.onnxDir, {
    executionProviders: ['webgpu', 'wasm'],
    graphOptimizationLevel: 'all'
  })

  return 'webgpu, wasm'
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

  const style = await getVoiceStyle(voiceId)
  const { wav, duration } = await mutex.runExclusive(() => engine!.textToSpeech._infer([text], style, numSteps))
  const pcmData: PcmData = {
    samples: wav,
    sampleRate: engine.cfgs.ae.sample_rate,
    numChannels: 1
  }
  return new TransferableResult(pcmData, [pcmData.samples.buffer])
}

async function dispose(args: Record<string, unknown>) {
  if (!engine) {
    throw new Error('Not initialized')
  }

  const results = await engine.textToSpeech.dispose()
  if (results.some(x => x.status == 'rejected')) {
    console.error('Fail to dispose', results)
  }
  engine = undefined
}
