import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config from "./config"
import { MyVoice } from "./types"
import { immediate } from "./utils"


export async function getInstallState(): Promise<boolean> {
  const cache = await caches.open(config.supertonicCacheKey)
  for (const url of config.installables) {
    if (!await cache.match(url)) return false
  }
  return true
}


export function advertiseVoices(voiceList: readonly MyVoice[]) {
  parent?.postMessage(<Message>{
    type: "notification",
    to: "supertonic-host",
    method: "advertiseVoices",
    args: {
      voices: voiceList.map(voice => ({
        voiceName: `Supertonic ${voice.id}`,
        lang: voice.lang,
        eventTypes: ["start", "sentence", "end", "error"]
      }))
    }
  }, "*")
}


export function parseAdvertisedVoiceName(name: string): string {
  const [_, voiceId] = name.split(" ")
  return voiceId
}


export const sampler = immediate(() => {
  const audio = new Audio()
  audio.crossOrigin = "anonymous"
  audio.autoplay = true
  return {
    play(voice: MyVoice) {
      audio.src = `samples/${voice.id}.mp3`
    },
    stop() {
      audio.pause()
    }
  }
})


export const messageDispatcher = immediate(() => {
  const dispatcher = makeDispatcher<{send(msg: unknown): void}>("supertonic-service", {})
  addEventListener("message", event => {
    const send = (msg: unknown) => event.source!.postMessage(msg, {targetOrigin: event.origin})
    dispatcher.dispatch(event.data, {send}, send)
  })
  return dispatcher
})
