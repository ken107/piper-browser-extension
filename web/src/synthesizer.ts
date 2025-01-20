import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import { ModelStatus, PcmData, Voice } from "./types"
import { immediate } from "./utils"

export const modelStatus$ = new rxjs.BehaviorSubject<ModelStatus>({status: "unloaded"})

const worker = immediate(() => {
  const worker = new Worker(new URL("./inference-worker.ts", import.meta.url), {type: "module"})
  const dispatcher = makeDispatcher("tts-service", {
    onModelStatus(args) {
      modelStatus$.next(args as ModelStatus)
    }
  })
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage))
  return {
    request<T>(method: string, args: Record<string, unknown>) {
      const id = String(Math.random())
      worker.postMessage({to: "tts-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    }
  }
})

export function getVoiceList() {
  return worker.request<Voice[]>("getVoiceList", {})
}

export function synthesize(text: string, voiceId: string) {
  return worker.request<PcmData>("synthesize", {text, voiceId})
}
