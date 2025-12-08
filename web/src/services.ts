import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import config from "./config"
import { LoadState, MyVoice } from "./types"
import { immediate, wrapStream } from "./utils"


export async function getInstallState(): Promise<LoadState> {
  const cache = await caches.open(config.supertonicCacheKey)
  for (const url of config.installables) {
    if (!await cache.match(url)) return { type: 'not-installed' }
  }
  return { type: 'installed' }
}


export function install(): rxjs.Observable<string> {
  return rxjs.defer(() => caches.open(config.supertonicCacheKey)).pipe(
    //get missing entries
    rxjs.exhaustMap(cache =>
      rxjs.from(config.installables).pipe(
        rxjs.mergeMap(url =>
          rxjs.defer(() => cache.match(url)).pipe(
            rxjs.exhaustMap(response =>
              rxjs.iif(
                () => !response,
                rxjs.of(url),
                rxjs.EMPTY
              )
            )
          )
        ),
        rxjs.toArray(),
        rxjs.map(missing => [cache, missing] as const)
      )
    ),
    //fetch missing entries
    rxjs.exhaustMap(([cache, missing]) =>
      rxjs.from(missing).pipe(
        rxjs.mergeMap((url, index) =>
          rxjs.defer(async () => {
            const res = await fetch(url)
            if (!res.ok) throw new Error(`Server return ${res.status}`)
            if (!res.body) throw new Error(`Empty body`)
            return res
          }).pipe(
            rxjs.exhaustMap(res => {
              const contentLength = res.headers.get('content-length')
              const total = contentLength ? Number(contentLength) : null
              return new rxjs.Observable<number>(subscriber => {
                const stream = wrapStream(res.body!, chunk => subscriber.next(chunk.byteLength))
                let streamConsumed = false
                cache.put(url, new Response(stream, res)).then(
                  () => {
                    streamConsumed = true
                    subscriber.complete()
                  },
                  err => {
                    streamConsumed = true
                    subscriber.error(err)
                  }
                )
                return () => {
                  if (!streamConsumed) {
                    stream.cancel('unsubscribed').catch(console.error)
                  }
                }
              }).pipe(
                rxjs.scan((sum, bytes) => sum + bytes, 0),
                rxjs.map(loaded => ({ index, loaded, total }))
              )
            })
          )
        ),
        rxjs.scan((acc, { index, loaded, total }) => {
          acc[index] = { loaded, total }
          return acc
        }, Array.from(missing, () => ({ loaded: 0, total: null as number|null }))),
        rxjs.map(acc => {
          const loaded = acc.reduce((sum, { loaded }) => sum + loaded, 0)
          if (acc.every(x => x.total == null)) {
            return Math.round(loaded / 1_000_000) + ' MB'
          } else {
            const total = acc.reduce((sum, { loaded, total }) => sum + (total ?? loaded), 0)
            return Math.round(100 * loaded / total) + '%'
          }
        }),
        rxjs.startWith('0%')
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
