import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as ort from "onnxruntime-web"
import config from "./config"
import { deleteFile, getFile } from "./storage"
import { InstallState, ModelConfig, MyVoice, PiperVoice, Speech, Synthesizer } from "./types"
import { fetchWithProgress, immediate } from "./utils"

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


export async function getInstalledVoice(voiceKey: string) {
  const [model, modelConfig] = await Promise.all([
    getFile(voiceKey + ".onnx"),
    getFile(voiceKey + ".json")
  ])
  return {
    model,
    modelConfig: JSON.parse(await modelConfig.text()) as ModelConfig
  }
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
  top?.postMessage(<Message>{
    type: "notification",
    to: "piper-host",
    method: "advertiseVoices",
    args: {
      voices: voices
        .map(voice => ({
          voiceName: "Piper " + voice.key + " (" + voice.languageName + ")",
          lang: voice.languageCode,
          eventTypes: ["start", "end", "error"]
        }))
        .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
    }
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
    async speak({utterance, pitch, rate, volume}) {
      console.log("Speaking", {pitch, rate, volume}, utterance)
      await new Promise(f => setTimeout(f, 1000))
      const endPromise = new Promise<void>(f => setTimeout(f, 6000))
      return {
        async pause() {
          throw new Error("Not impl")
        },
        async resume() {
          throw new Error("Not impl")
        },
        async stop() {
          throw new Error("Not impl")
        },
        wait() {
          return endPromise
        }
      }
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


export const messageDispatcher = makeDispatcher("piper-service", {})

addEventListener("message", event => {
  messageDispatcher.dispatch(event.data, null, res => event.source!.postMessage(res, {targetOrigin: event.origin}))
})


export const speechManager = immediate(() => {
  const speeches = new Map<string, Speech>()
  return {
    add(speech: Speech) {
      const id = String(Math.random())
      speeches.set(id, speech)
      speech.wait().finally(() => speeches.delete(id))
      return id
    },
    get(id: string) {
      return speeches.get(id)
    }
  }
})
