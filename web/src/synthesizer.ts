import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { makePhonemizer } from "./phonemizer"
import { playAudio } from "./player"
import { ModelConfig, PcmData, Synthesizer } from "./types"
import { immediate } from "./utils"

const worker = immediate(() => {
  const worker = new Worker("inference-worker.js")
  const dispatcher = makeDispatcher("piper-service", {})
  worker.addEventListener("message", event => dispatcher.dispatch(event.data, null, worker.postMessage))
  return {
    request<T>(method: string, args: Record<string, unknown>) {
      const id = String(Date.now())
      worker.postMessage({to: "piper-worker", type: "request", id, method, args})
      return dispatcher.waitForResponse<T>(id)
    }
  }
})


export async function makeSynthesizer(model: Blob, modelConfig: ModelConfig): Promise<Synthesizer> {
  const phonemizer = makePhonemizer(modelConfig)
  const engineId = await worker.request("makeInferenceEngine", {model, modelConfig})

  async function synthesize(
    {phonemes, phonemeIds}: {phonemes: string[], phonemeIds: number[]},
    speakerId: number|undefined
  ) {
    const start = Date.now()
    try {
      return await worker.request<PcmData>("infer", {engineId, phonemeIds, speakerId})
    }
    finally {
      console.debug("Synthesized", phonemes.length, "in", Date.now()-start, phonemes.join(""))
    }
  }

  return {
    async speak({speakerId, utterance, pitch, rate, volume}, control, {onSentenceBoundary}) {
      const phrases = await phonemizer.phonemize(utterance)
      if (control.getState() == "stop") throw {name: "interrupted", message: "Playback interrupted"}

      const prefetch = new Array<Promise<PcmData>|undefined>(phrases.length)
      for (let index = 0; index < phrases.length; index++) {
        const pcmData = await (prefetch[index] || (prefetch[index] = synthesize(phrases[index], speakerId)))
        if (await control.wait(state => state != "pause") == "stop") throw {name: "interrupted", message: "Playback interrupted"}

        let numPhonemesToPrefetch = 100
        for (let i = index + 1; i < phrases.length && numPhonemesToPrefetch > 0; i++) {
          const phrase = phrases[i]
          if (!prefetch[i]) {
            prefetch[i] = prefetch[i-1]!
              .then(() => {
                if (control.getState() == "stop") throw {name: "interrupted", message: "Prefetch interrupted"}
                return synthesize(phrase, speakerId)
              })
          }
          numPhonemesToPrefetch -= phrase.phonemes.length
        }

        await playAudio(pcmData, phrases[index].silenceSeconds, pitch, rate, volume, control)
        if (control.getState() == "stop") throw {name: "interrupted", message: "Playback interrupted"}
      }
    },

    dispose() {
      worker.request("dispose", {engineId}).catch(console.error)
    }
  }
}
