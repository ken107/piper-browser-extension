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


/**
 * Waits until the Service Worker is active AND controlling the page.
 * This ensures that any fetch() request made after this promise resolves
 * will be intercepted by the Service Worker.
 */
export async function ensureServiceWorkerIsControlling(): Promise<ServiceWorkerRegistration> {
  // 1. First, wait for the Service Worker to be 'active' (ready).
  const registration = await navigator.serviceWorker.ready;

  // 2. Check if the Service Worker is already controlling this page.
  // On a reload, this will likely be true immediately.
  if (navigator.serviceWorker.controller) {
    return registration;
  }

  // 3. If it is active but not yet controlling (the "First Load" race condition),
  // we must wait for the 'controllerchange' event. This event fires when
  // clients.claim() finishes executing in the Service Worker.
  return new Promise((resolve) => {
    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(registration);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}
