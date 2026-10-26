import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { getVoice } from "./services"
import { PcmData } from "./types"
import { lazy } from "./utils"


//created on first use, so it starts after the page is controlled by the service worker and its fetches get cached
const getWorker = lazy(() => {
  const worker = new Worker(new URL("inference-worker.ts", import.meta.url))
  const dispatcher = makeDispatcher("pocket-service", {})
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage))
  return {
    request<T>(method: string, args: Record<string, unknown> = {}) {
      const id = String(Math.random())
      worker.postMessage({to: "pocket-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    }
  }
})


export interface EngineInfo {
  sampleRate: number
  numThreads: number
  hardwareConcurrency: number
  crossOriginIsolated: boolean
}

export interface SynthesisStats {
  textLength: number
  audioSeconds: number
  synthSeconds: number
}

export function makeSynthesizer(repoPath: string, onSynthesized?: (stats: SynthesisStats) => void) {
  const readyPromise = getWorker().request<EngineInfo>("initialize", { repoPath })

  //voices are cloned from their reference clips, added to the engine on first use
  const addedVoices = new Map<string, Promise<void>>()
  function ensureVoice(voiceId: string) {
    let promise = addedVoices.get(voiceId)
    if (!promise) {
      const voice = getVoice(voiceId)
      promise = readyPromise
        .then(({sampleRate}) => loadClip(voice.clip, sampleRate))
        .then(clip => getWorker().request<void>("addVoice", {voiceId, clip}))
      promise.catch(() => addedVoices.delete(voiceId))
      addedVoices.set(voiceId, promise)
    }
    return promise
  }

  return {
    readyPromise,
    prepareVoice: ensureVoice,
    async synthesize(text: string, voiceId: string, numSteps: number) {
      await ensureVoice(voiceId)
      const {synthMs, ...pcmData} = await getWorker().request<PcmData & {synthMs: number}>("infer", {text, voiceId, numSteps})
      const stats: SynthesisStats = {
        textLength: text.length,
        audioSeconds: pcmData.samples.length / pcmData.numChannels / pcmData.sampleRate,
        synthSeconds: synthMs / 1000
      }
      console.debug("Synthesized", stats, text)
      onSynthesized?.(stats)
      return pcmData as PcmData
    },
    async dispose() {
      await readyPromise
      await getWorker().request("dispose")
    }
  }
}


//decode the clip, resampled to the engine's sample rate (workers have no AudioContext), downmixed to mono
async function loadClip(url: string, sampleRate: number) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`)
  const audioBuffer = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(await res.arrayBuffer())
  const clip = new Float32Array(audioBuffer.length)
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    const channel = audioBuffer.getChannelData(c)
    for (let i = 0; i < clip.length; i++) clip[i] += channel[i] / audioBuffer.numberOfChannels
  }
  return clip
}
