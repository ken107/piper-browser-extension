import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { PcmData } from "./types"
import { immediate } from "./utils"


const worker = immediate(() => {
  const worker = new Worker(new URL("inference-worker.ts", import.meta.url))
  const dispatcher = makeDispatcher("piper-service", {})
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage))
  return {
    request<T>(method: string, args: Record<string, unknown> = {}) {
      const id = String(Math.random())
      worker.postMessage({to: "piper-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    }
  }
})


export function makeSynthesizer() {
  const readyPromise = worker.request("initialize")
  return {
    readyPromise,
    async synthesize(text: string, voiceId: string, numSteps: number) {
      await readyPromise
      const start = Date.now()
      try {
        return await worker.request<PcmData>("infer", {text, voiceId, numSteps})
      }
      finally {
        console.debug("Synthesized", text.length, "in", Date.now()-start, text)
      }
    },
    async dispose() {
      await readyPromise
      await worker.request("dispose")
    }
  }
}
