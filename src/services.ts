import * as ort from "onnxruntime-web"
import config from "./config"
import { getFile } from "./storage"
import { ModelConfig, MyVoice, PiperVoice, Synthesizer } from "./types"
import { immediate } from "./utils"


export async function getVoiceList(): Promise<MyVoice[]> {
  const blob = await getFile("voices.json", () => piperFetch("voices.json"))
  const voicesJson: Record<string, PiperVoice> = await blob.text().then(JSON.parse)
  const voiceList = Object.values(voicesJson)
    .map<MyVoice>(voice => {
      const modelFile = Object.keys(voice.files).find(x => x.endsWith(".onnx"))
      if (!modelFile) throw new Error("Can't identify model file for " + voice.name)
      return {
        key: voice.key,
        name: voice.name,
        languageCode: voice.language.family.toLowerCase() + "-" + voice.language.region.toUpperCase(),
        languageName: voice.language.name_native + " [" + voice.language.country_english + "]",
        quality: voice.quality,
        modelFile,
        modelFileSize: voice.files[modelFile].size_bytes,
        installState: "not-installed",
        loadState: "not-loaded"
      }
    })
  for (const voice of voiceList) {
    voice.installState = await getFile(voice.modelFile)
      .then(() => "installed" as const)
      .catch(err => "not-installed")
  }
  return voiceList
}


export function advertiseVoices(voices: MyVoice[]) {
  (chrome.ttsEngine as any).updateVoices(
    voices
      .map(voice => ({
        voiceName: voice.name,
        lang: voice.languageCode,
        eventTypes: ["start", "end", "error"]
      }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
  )
}


export const sampler = immediate(() => {
  const audio = new Audio()
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
    synthesize(text) {
      return {
        startPromise: Promise.reject("Not impl"),
        endPromise: Promise.reject("Not impl")
      }
    }
  }
}


export async function piperFetch(file: string) {
  const res = await fetch(config.repoUrl + file)
  if (!res.ok) throw new Error("Server return " + res.status)
  return res.blob()
}
