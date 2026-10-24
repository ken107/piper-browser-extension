import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config from "./config"
import { InstallState, MyVoice } from "./types"
import { immediate } from "./utils"


export async function getInstallState(): Promise<InstallState|null> {
  if (config.extensionUrl) {
    const res = await fetch(`${config.extensionUrl}/${config.installables[0]}`, { method: 'HEAD' }).catch(err => ({ ok: false }))
    if (res.ok) {
      return {
        repoType: 'extension',
        repoPath: config.extensionUrl
      }
    }
  }
  const cache = await caches.open(config.pocketCacheKey)
  for (const file of config.installables) {
    if (!await cache.match(`${config.pocketRepoPath}/${file}`)) return null
  }
  return {
    repoType: 'cache',
    repoPath: config.pocketRepoPath
  }
}


export async function uninstall(): Promise<void> {
  await caches.delete(config.pocketCacheKey)
}


export function advertiseVoices(voiceList: readonly MyVoice[]) {
  (parent ?? opener)?.postMessage(<Message>{
    type: "notification",
    to: "pocket-host",
    method: "advertiseVoices",
    args: {
      voices: voiceList.map(voice => ({
        voiceName: `PocketTTS ${voice.id}`,
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
  const dispatcher = makeDispatcher<{send(msg: unknown): void}>("pocket-service", {})
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

  // 3. If it is active but not yet controlling, we must wait for the 'controllerchange' event,
  // which fires when clients.claim() finishes executing in the Service Worker. That happens on
  // its own on first load (the SW claims on activate), but a hard reload (Shift+Reload) bypasses
  // an already-active SW, so we ask it to claim us.
  return new Promise((resolve) => {
    const onControllerChange = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(registration);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    registration.active?.postMessage({ type: 'claim' });
  });
}
