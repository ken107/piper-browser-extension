import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config, { pocketModels, PocketModel } from "./config"
import { InstallState, MyVoice } from "./types"
import { immediate } from "./utils"


export function loadModel(): PocketModel {
  try {
    return pocketModels.find(model => model.id == localStorage.getItem('pocketModel')) ?? pocketModels[0]
  } catch { return pocketModels[0] }
}

export function saveModel(model: PocketModel) {
  try { localStorage.setItem('pocketModel', model.id) } catch {}
}

export async function getInstallState(model: PocketModel = loadModel()): Promise<InstallState|null> {
  if (config.extensionUrl && model.id == pocketModels[0].id) {
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
    if (!await cache.match(`${model.repoPath}/${file}`)) return null
  }
  return {
    repoType: 'cache',
    repoPath: model.repoPath
  }
}


export async function uninstall(): Promise<void> {
  await caches.delete(config.pocketCacheKey)
}


//voices are cloned from their reference clips, the registry maps voice ids to clips;
//it holds the curated list from voices.json plus any donated voices the user picks
const voiceRegistry = new Map<string, MyVoice>()

export function registerVoice(voice: MyVoice) {
  voiceRegistry.set(voice.id, voice)
}

export const addedVoicesStorageKey = 'pocketAddedVoices'

export function loadAddedVoices(): MyVoice[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(addedVoicesStorageKey) ?? '[]')
    if (!Array.isArray(saved)) return []
    const voices = new Map<string, MyVoice>()
    for (const voice of saved) {
      if (!voice || !['id', 'label', 'clip', 'license', 'source', 'sourceUrl']
        .every(key => typeof voice[key] == 'string')) continue
      if (!voice.id || /\s/.test(voice.id) ||
        !voice.clip.startsWith(`${config.voicesRepoPath}/voice-donations/`) ||
        voice.sourceUrl != 'https://unmute.sh/voice-donation') continue
      //Only restore the fields used by donated voices, not arbitrary saved properties.
      const { id, label, clip, license, source, sourceUrl } = voice
      voices.set(id, { id, label, clip, license, source, sourceUrl })
    }
    return [...voices.values()]
  } catch { return [] }
}

export function saveAddedVoices(voices: readonly MyVoice[]) {
  //Let the caller report storage errors instead of pretending the selection was saved.
  localStorage.setItem(addedVoicesStorageKey, JSON.stringify(voices))
}

export function getVoice(voiceId: string) {
  const voice = voiceRegistry.get(voiceId)
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`)
  return voice
}

//the curated voice list is hosted next to the page, so it can be edited without a rebuild
export async function loadVoiceList(): Promise<MyVoice[]> {
  //revalidate, the host serves it with a long max-age
  const res = await fetch('voices.json', { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Failed to load voices.json (${res.status})`)
  const { voices } = await res.json() as { voices: MyVoice[] }
  for (const voice of voices) {
    if (!voice.clip.startsWith(config.voicesRepoPath)) throw new Error(`Clip not in voice repo: ${voice.clip}`)
    registerVoice(voice)
  }
  return voices
}

//list the CC0 voice donations live from the voice repo, keeping one clip per voice (preferring the enhanced one);
//the .safetensors files there are embeddings for Kyutai TTS 1.6B, not Pocket TTS
export async function listDonatedVoices(): Promise<MyVoice[]> {
  const files: string[] = []
  let url: string|null = `${config.voicesApiPath}/tree/main/voice-donations`
  while (url) {
    const res: Response = await fetch(url)
    if (!res.ok) throw new Error(`Failed to list voice donations (${res.status})`)
    const entries = await res.json() as { type: string, path: string }[]
    files.push(...entries.filter(x => x.type == 'file' && x.path.endsWith('.wav')).map(x => x.path))
    url = res.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
  }

  const clips = new Map<string, string>()
  for (const path of files) {
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/(_enhanced)?\.wav$/, '')
    if (!clips.has(stem) || path.endsWith('_enhanced.wav')) clips.set(stem, path)
  }
  return [...clips].map(([stem, path]) => ({
    id: stem,
    label: stem.replace(/_+/g, ' ').trim(),
    clip: `${config.voicesRepoPath}/${path.split('/').map(encodeURIComponent).join('/')}`,
    license: 'CC0',
    source: 'Unmute Voice Donation Project',
    sourceUrl: 'https://unmute.sh/voice-donation',
  }))
}


export function advertiseVoices(voiceList: readonly MyVoice[], modelLanguage: string) {
  (parent ?? opener)?.postMessage(<Message>{
    type: "notification",
    to: "pocket-host",
    method: "advertiseVoices",
    args: {
      voices: voiceList.map(voice => ({
        voiceName: `PocketTTS ${voice.id}`,
        lang: modelLanguage,
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
      audio.src = voice.sample ?? voice.clip
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
