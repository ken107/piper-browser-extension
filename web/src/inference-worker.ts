import { env } from "@huggingface/transformers"
import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { KokoroTTS } from "kokoro-js"
import { PcmData, Voice } from "./types"
import { lazy } from "./utils"

if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = navigator.hardwareConcurrency
}



class TransferableResult {
  constructor(public result: unknown, public transfer: Transferable[]) {}
}

const dispatcher = makeDispatcher("tts-worker", {getVoiceList, synthesize})

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



const getKokoro = lazy(() => {
  let file = ""
  return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", {
    dtype: "q8",
    progress_callback(info) {
      switch (info.status) {
        case "initiate":
          if (info.file.endsWith(".onnx")) file = info.file
          break
        case "download":
          if (info.file == file) notifySuper("onModelStatus", {status: "loading", percent: 0})
          break
        case "progress":
          if (info.file == file) notifySuper("onModelStatus", {status: "loading", percent: info.progress})
          break
        case "done":
          if (info.file == file) notifySuper("onModelStatus", {status: "ready"})
          break
      }
    }
  })
})

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
