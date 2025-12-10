import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import config from "./config"
import { MyVoice } from "./types"
import { immediate } from "./utils"


export const serviceWorkerReady = rxjs.firstValueFrom(
  rxjs.defer(() => navigator.serviceWorker.register('./sw.js')).pipe(
    rxjs.exhaustMap(registration => {
      if (registration.active)
        return rxjs.of(registration)

      const sw = registration.installing || registration.waiting
      if (!sw)
        return rxjs.of(registration)

      return rxjs.fromEvent(sw, 'statechange').pipe(
        rxjs.find(() => sw.state == 'activated'),
        rxjs.map(() => registration)
      )
    })
  )
)


export async function getInstallState(): Promise<boolean> {
  const cache = await caches.open(config.supertonicCacheKey)
  for (const url of config.installables) {
    if (!await cache.match(url)) return false
  }
  return true
}


export async function uninstall(): Promise<void> {
  await caches.delete(config.supertonicCacheKey)
}


export function advertiseVoices(voiceList: readonly MyVoice[]) {
  (parent ?? opener)?.postMessage(<Message>{
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
