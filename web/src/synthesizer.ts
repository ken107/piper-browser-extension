import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { getInstalledVoice } from "./services"
import { PcmData } from "./types"
import { immediate } from "./utils"
import { makePhonemizer } from "./phonemizer"


const worker = immediate(() => {
  const worker = new Worker("inference-worker.js")
  const dispatcher = makeDispatcher("piper-service", {})
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage))
  return {
    request<T>(method: string, args: Record<string, unknown>) {
      const id = String(Math.random())
      worker.postMessage({to: "piper-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    }
  }
})


export function makeSynthesizer(voiceKey: string) {
  const modelPromise = getInstalledVoice(voiceKey)
  const readyPromise = modelPromise
    .then(({model, modelConfig}) => worker.request("makeInferenceEngine", {model, modelConfig}))
  return {
    readyPromise,
    phonemizerPromise: modelPromise.then(({modelConfig}) => makePhonemizer(modelConfig)),
    async synthesize(
      {phonemes, phonemeIds}: {phonemes: string[], phonemeIds: number[]},
      speakerId: number|undefined
    ) {
      const engineId = await readyPromise
      const start = Date.now()
      try {
        return await worker.request<PcmData>("infer", {engineId, phonemeIds, speakerId})
      }
      finally {
        console.debug("Synthesized", phonemes.length, "in", Date.now()-start, phonemes.join(""))
      }
    },
    dispose() {
      readyPromise
        .then(engineId => worker.request("dispose", {engineId}))
        .catch(console.error)
    }
  }
}
