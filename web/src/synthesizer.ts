import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
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
  return {
    readyPromise,
    async synthesize(text: string, voiceId: string, numSteps: number) {
      await readyPromise
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
