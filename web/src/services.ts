import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config from "./config"
import { deleteFile, getFile } from "./storage"
import { AdvertisedVoice, InstallState, LoadState, ModelConfig, MyVoice, PiperVoice, Speech, Synthesizer } from "./types"
import { fetchWithProgress, immediate } from "./utils"


export async function getVoiceList(): Promise<MyVoice[]> {
  const blob = await getFile("voices.json", () => piperFetch("voices.json"))
  const voicesJson: Record<string, PiperVoice> = await blob.text().then(JSON.parse)
  const voiceList = Object.values(voicesJson)
    .filter(voice => !config.excludeVoices.has(voice.key))
    .map(voice => {
      const modelFile = Object.keys(voice.files).find(x => x.endsWith(".onnx"))
      if (!modelFile) throw new Error("Can't identify model file for " + voice.name)
      return {
        ...voice,
        modelFile,
        modelFileSize: voice.files[modelFile].size_bytes,
        installState: "not-installed" as InstallState,
        loadState: "not-loaded" as LoadState,
        numActiveUsers: 0,
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


export function advertiseVoices(voices: AdvertisedVoice[]) {
  top?.postMessage(<Message>{
    type: "notification",
    to: "piper-host",
    method: "advertiseVoices",
    args: {voices}
  }, "*")
}


export function makeAdvertisedVoiceList(voiceList: MyVoice[]|null): AdvertisedVoice[]|null {
  if (voiceList == null) return null
  const installed = voiceList.filter(x => x.installState == "installed")
  const advertised = installed.length ? installed : voiceList
  return advertised
    .flatMap<AdvertisedVoice>(voice => {
      const modelId = voice.key.split("-").slice(1).join("-")
      const lang = voice.language.code.replace(/_/g, "-")
      const eventTypes = ["start", "end", "error"]
      const speakerNames = voice.speaker_id_map ? Object.keys(voice.speaker_id_map) : []
      if (speakerNames.length) {
        return speakerNames
          .map<AdvertisedVoice>(speakerName => ({
            voiceName: `Piper ${modelId} ${speakerName} (${voice.language.name_native})`,
            lang,
            eventTypes
          }))
      }
      else {
        return {
          voiceName: `Piper ${modelId} (${voice.language.name_native})`,
          lang,
          eventTypes
        }
      }
    })
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
}


export function parseAdvertisedVoiceName(name: string): {modelId: string, speakerName?: string} {
  const [piper, modelId, speakerName] = name.split(" ")
  return {
    modelId,
    speakerName: speakerName.startsWith("(") ? undefined : speakerName
  }
}


export const sampler = immediate(() => {
  const audio = new Audio()
  audio.crossOrigin = "anonymous"
  audio.autoplay = true
  return {
    play(voice: MyVoice, speakerId?: number) {
      const tokens = voice.modelFile.split("/")
      tokens.pop()
      audio.src = config.repoUrl + tokens.join("/") + "/samples/speaker_" + (speakerId ?? 0) + ".mp3"
    },
    stop() {
      audio.pause()
    }
  }
})


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
      speech.finishPromise.finally(() => speeches.delete(id))
      return id
    },
    get(id: string) {
      return speeches.get(id)
    }
  }
})


export const speechCache = immediate(() => {
  const cache = new Map<string, {speech: Speech, timer: ReturnType<typeof setTimeout>}>()
  return {
    add(key: string, speech: Speech, ttl: number) {
      cache.set(key, {
        speech,
        timer: setTimeout(() => cache.delete(key), ttl)
      })
    },
    remove(key: string) {
      const entry = cache.get(key)
      if (entry) {
        clearTimeout(entry.timer)
        return entry.speech
      }
    }
  }
})


export const synthesizers = new Map<string, Synthesizer>()
