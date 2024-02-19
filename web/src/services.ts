import * as ort from "onnxruntime-web"
import config from "./config"
import { deleteFile, getFile } from "./storage"
import { InstallState, ModelConfig, MyRequest, MyVoice, PiperVoice, Synthesizer } from "./types"
import { fetchWithProgress, immediate, randomString } from "./utils"

ort.env.wasm.numThreads = navigator.hardwareConcurrency


export async function getVoiceList(): Promise<MyVoice[]> {
  const blob = await getFile("voices.json", () => piperFetch("voices.json"))
  const voicesJson: Record<string, PiperVoice> = await blob.text().then(JSON.parse)
  const voiceList = Object.values(voicesJson)
    .map(voice => {
      const modelFile = Object.keys(voice.files).find(x => x.endsWith(".onnx"))
      if (!modelFile) throw new Error("Can't identify model file for " + voice.name)
      return {
        key: voice.key,
        name: voice.name,
        languageCode: voice.language.family.toLowerCase() + "-" + voice.language.region.toUpperCase(),
        languageName: voice.language.name_native,
        quality: voice.quality,
        modelFile,
        modelFileSize: voice.files[modelFile].size_bytes,
        installState: "not-installed" as InstallState,
      }
    })
  for (const voice of voiceList) {
    voice.installState = await getFile(voice.key + ".onnx")
      .then(() => "installed" as const)
      .catch(err => "not-installed")
  }
  return voiceList
}


export async function installVoice(voice: MyVoice, onProgress: (percent: number) => void) {
  const [model, modelConfig] = await Promise.all([
    getFile(voice.key + ".onnx", () => piperFetch(voice.modelFile, onProgress)),
    getFile(voice.key + ".json", () => piperFetch(voice.modelFile + ".json"))
  ])
  return {
    model,
    modelConfig: JSON.parse(await modelConfig.text()) as ModelConfig
  }
}


export async function deleteVoice(voice: MyVoice) {
  await deleteFile(voice.key + ".onnx")
  await deleteFile(voice.key + ".json")
}


export function advertiseVoices(voices: MyVoice[]) {
  top?.postMessage({
    method: "advertiseVoices",
    voices: voices
      .map(voice => ({
        voiceName: "Piper " + voice.key + " (" + voice.languageName + ")",
        lang: voice.languageCode,
        eventTypes: ["start", "end", "error"]
      }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
  }, "*")
}


export const sampler = immediate(() => {
  const audio = new Audio()
  audio.crossOrigin = "anonymous"
  audio.autoplay = true
  return {
    play(voice: MyVoice) {
      const tokens = voice.modelFile.split("/")
      tokens.pop()
      audio.src = config.repoUrl + tokens.join("/") + "/samples/speaker_0.mp3"
    },
    stop() {
      audio.pause()
    }
  }
})


export function createSynthesizer(model: Blob, modelConfig: ModelConfig): Synthesizer {
  const session = ort.InferenceSession.create(URL.createObjectURL(model))
  return {
    isBusy: false,
    speak(text) {
      return Promise.reject("Not impl")
    }
  }
}


export async function piperFetch(file: string, onProgress?: (percent: number) => void) {
  if (onProgress) {
    return fetchWithProgress(config.repoUrl + file, onProgress)
  }
  else {
    const res = await fetch(config.repoUrl + file)
    if (!res.ok) throw new Error("Server return " + res.status)
    return res.blob()
  }
}


export const requestListener = immediate(() => {
  let handlers: Record<string, (req: MyRequest) => unknown> = {}
  addEventListener("message", async event => {
    const req = event.data as MyRequest
    if (handlers[req.method]) {
      try {
        const result = await handlers[req.method](req)
        if (req.id) event.source!.postMessage({id: req.id, result})
      }
      catch (error) {
        if (req.id) event.source!.postMessage({id: req.id, error})
      }
    }
    else {
      console.error("No handler for method", req.method)
    }
  })
  return {
    setHandlers(requestHandlers: typeof handlers) {
      handlers = requestHandlers
    }
  }
})


export const jobManager = immediate(() => {
  const jobs = new Map<string, Promise<any>>()
  return {
    add(job: Promise<any>) {
      const id = randomString()
      jobs.set(id, job)
      job.finally(() => setTimeout(() => jobs.delete(id), 5000))
      return id
    },
    wait<T>(id: string): Promise<T> {
      const job = jobs.get(id)
      if (!job) throw new Error("No job with id " + id)
      return job
    }
  }
})
