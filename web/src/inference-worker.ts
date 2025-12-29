import { env } from "@huggingface/transformers"
import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { KokoroTTS } from "kokoro-js"
import { ModelStatus, PcmData, Voice, ModelSettings } from "./types"

if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency
}



class TransferableResult {
  constructor(public result: unknown, public transfer: Transferable[]) {}
}

// Store settings received from main thread
let currentSettings: ModelSettings | null = null

function onSettingsChanged(args: Record<string, unknown>) {
  if (args.settings) {
    currentSettings = args.settings as ModelSettings
  }
  kokoroInstance = null
  notifySuper("onModelStatus", {status: "unloaded"})
}

const dispatcher = makeDispatcher("tts-worker", {getVoiceList, synthesize, onSettingsChanged})

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

function notifySuper(method: string, args: Record<string, unknown>) {
  postMessage({
    to: "tts-service",
    type: "notification",
    method, args
  })
}



let kokoroInstance: Promise<KokoroTTS> | null = null

function getKokoro() {
  if (!kokoroInstance) {
    // Use settings passed from main thread, or fall back to defaults
    const settings = currentSettings || { quantization: 'fp32' as const, device: 'webgpu' as const }
    let file = ""
    console.info('Loading model', settings)
    kokoroInstance = KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", {
      dtype: settings.quantization,
      device: settings.device,
      progress_callback(info) {
        switch (info.status) {
          case "initiate":
            if (info.file.endsWith(".onnx")) file = info.file
            break
          case "download":
            if (info.file == file) notifySuper("onModelStatus", {status: "loading", percent: 0} satisfies ModelStatus)
            break
          case "progress":
            if (info.file == file) notifySuper("onModelStatus", {status: "loading", percent: info.progress} satisfies ModelStatus)
            break
          case "done":
            if (info.file == file) notifySuper("onModelStatus", {status: "ready"} satisfies ModelStatus)
            break
        }
      }
    })
  }
  return kokoroInstance
}

async function getVoiceList(): Promise<Voice[]> {
  const { voices } = await getKokoro()
  return Object.entries(voices)
    .map(([id, { name, language, gender }]) => ({ id, name, language, gender }))
}

async function synthesize(args: Record<string, unknown>) {
  const text = args.text as string
  const voiceId = args.voiceId as string

  const kokoro = await getKokoro()
  const start = Date.now()
  try {
    const rawAudio = await kokoro.generate(text, { voice: voiceId as any })
    const pcmData: PcmData = {
      samples: rawAudio.audio,
      sampleRate: rawAudio.sampling_rate,
      numChannels: 1
    }
    return new TransferableResult(pcmData, [pcmData.samples.buffer])
  }
  finally {
    console.debug("Synthesized", Date.now() - start, text)
  }
}
