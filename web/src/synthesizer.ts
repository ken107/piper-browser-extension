import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config from "./config"
import { Phrase, makePhonemizer } from "./phonemizer"
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
      interface MyPhrase extends Phrase {
        onEnd?: () => void
      }

      const phrases = immediate(async function*() {
        const paragraphs = splitParagraphs(utterance)
        let charIndex = 0

        for (let i = 0; i < paragraphs.length; i++) {
          const isLastParagraph = i == paragraphs.length - 1
          charIndex += paragraphs[i].length

          const phrases: MyPhrase[] = await phonemizer.phonemize(paragraphs[i])
          if (phrases.length) {
            const lastPhrase = phrases[phrases.length - 1]
            lastPhrase.silenceSeconds = config.paragraphSilenceSeconds
            if (!isLastParagraph) lastPhrase.onEnd = onSentenceBoundary.bind(null, charIndex)
            yield* phrases
          }
        }
      })

      const audioSegments = immediate(async function*() {
        const prefetch = [] as Array<{phrase: MyPhrase, promise: Promise<PcmData>}>
        const numPhonemesPrefetched = function() {
          let count = 0
          for (let i = 1; i < prefetch.length; i++) count += prefetch[i].phrase.phonemes.length
          return count
        }
        for await (const phrase of phrases) {
          prefetch.push({
            phrase,
            promise: (prefetch.length ? prefetch[prefetch.length-1].promise : Promise.resolve())
              .then(() => {
                if (control.getState() == "stop") throw {name: "interrupted", message: "Prefetch interrupted"}
                return synthesize(phrase, speakerId)
              })
          })
          while (numPhonemesPrefetched() >= config.minPhonemesToPrefetch) yield prefetch.shift()!
        }
        yield* prefetch
      })

      for await (const {phrase, promise} of audioSegments) {
        await playAudio(await promise, phrase.silenceSeconds, pitch, rate, volume, control)
        if (control.getState() == "stop") throw {name: "interrupted", message: "Playback interrupted"}
        phrase.onEnd?.()
      }
    },

    dispose() {
      worker.request("dispose", {engineId}).catch(console.error)
    }
  }
}


function splitParagraphs(text: string) {
  const tokens = text.split(/(\n\n\s*)/)
  const paragraphs = []
  for (let i = 0; i < tokens.length; i += 2) paragraphs.push(tokens[i] + (tokens[i+1] ?? ''))
  return paragraphs
}
