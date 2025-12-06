import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import config from "./config"
import { Installable, LoadState, MyVoice } from "./types"
import { immediate, wrapStream } from "./utils"


export async function getInstallState(): Promise<LoadState> {
  const cache = await caches.open(config.supertonicCacheKey)
  for (const url of config.installables) {
    if (!await cache.match(url)) return { type: 'not-installed' }
  }
  return { type: 'installed' }
}


export function install(items: Installable[]): rxjs.Observable<{ loaded: number, total: number|null }> {
  return rxjs.defer(() => caches.open(config.supertonicCacheKey)).pipe(
    //get missing entries
    rxjs.exhaustMap(cache =>
      rxjs.from(items).pipe(
        rxjs.mergeMap(item =>
          rxjs.defer(() => cache.match(item.url)).pipe(
            rxjs.exhaustMap(response =>
              rxjs.iif(
                () => !response,
                rxjs.of(item),
                rxjs.EMPTY
              )
            )
          )
        ),
        rxjs.toArray(),
        rxjs.map(missing => ({
          cache,
          missing,
          total: missing.reduce((sum: number|null, {size}) => sum != null && size != null ? sum + size : null, 0)
        }))
      )
    ),
    //fetch missing entries
    rxjs.exhaustMap(({cache, missing, total}) =>
      rxjs.from(missing).pipe(
        rxjs.mergeMap(item =>
          rxjs.defer(async () => {
            const res = await fetch(item.url)
            if (!res.ok) throw new Error(`Server return ${res.status}`)
            if (!res.body) throw new Error(`Empty body`)
            return res
          }).pipe(
            rxjs.exhaustMap(res =>
              new rxjs.Observable<number>(subscriber => {
                const stream = wrapStream(res.body!, chunk => subscriber.next(chunk.byteLength))
                cache.put(item.url, new Response(stream, res)).then(
                  () => subscriber.complete(),
                  err => subscriber.error(err)
                )
                return () => stream.cancel('unsubscribed').catch(console.error)
              })
            )
          )
        ),
        rxjs.scan((sum, bytes) => sum + bytes, 0),
        rxjs.map(loaded => ({ loaded, total })),
        rxjs.startWith({ loaded: 0, total })
      )
    )
  )
}


export async function uninstall(): Promise<void> {
  await caches.delete(config.supertonicCacheKey)
}


export function advertiseVoices(voiceList: readonly MyVoice[]) {
  parent?.postMessage(<Message>{
    type: "notification",
    to: "piper-host",
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
  const dispatcher = makeDispatcher<{send(msg: unknown): void}>("piper-service", {})
  addEventListener("message", event => {
    const send = (msg: unknown) => event.source!.postMessage(msg, {targetOrigin: event.origin})
    dispatcher.dispatch(event.data, {send}, send)
  })
  return dispatcher
})
