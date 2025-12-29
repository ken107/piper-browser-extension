import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import { ModelStatus, PcmData, Voice } from "./types"
import { immediate, getModelSettings } from "./utils"

export const modelStatus$ = new rxjs.BehaviorSubject<ModelStatus>({status: "unloaded"})

const worker = immediate(() => {
  const worker = new Worker(new URL("./inference-worker.ts", import.meta.url), {type: "module"})
  const dispatcher = makeDispatcher("tts-service", {
    onModelStatus(args) {
      modelStatus$.next(args as ModelStatus)
    }
  })
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage.bind(worker)))
  return {
    request<T>(method: string, args: Record<string, unknown>) {
      const id = String(Math.random())
      worker.postMessage({to: "tts-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    },
    notify(method: string, args: Record<string, unknown>) {
      worker.postMessage({to: "tts-worker", type: "notification", method, args})
    }
  }
})

export function getVoiceList() {
  return worker.request<Voice[]>("getVoiceList", {})
}

export function synthesize(text: string, voiceId: string) {
  return worker.request<PcmData>("synthesize", {text, voiceId})
}

export function notifySettingsChanged() {
  const settings = getModelSettings()
  worker.notify("onSettingsChanged", { settings })
}
