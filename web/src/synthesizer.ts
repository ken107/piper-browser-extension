import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import { makeStateMachine } from "@lsdsoftware/state-machine"
import * as rxjs from "rxjs"
import config from "./config"
import { Phrase, makePhonemizer } from "./phonemizer"
import { playAudio } from "./player"
import { ModelConfig, PcmData, PlaybackCommand, Synthesizer } from "./types"
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
    async speak({speakerId, utterance, pitch, rate, volume}, control, {onSentence, onParagraph}) {
      interface Playing {
        endPromise: Promise<void>
        pause(): {
          resume(): Playing
        }
      }

      interface Item {
        phrase: Phrase
        onSelected(): void
        play(): Playing
      }

      const items: Item[] = immediate(() => {
        const paragraphs = splitParagraphs(utterance)
          .map(text => ({text, startIndex: 0, endIndex: 0}))
        for (let i = 0, charIndex = 0; i < paragraphs.length; charIndex += paragraphs[i].text.length, i++) {
          paragraphs[i].startIndex = charIndex
          paragraphs[i].endIndex = charIndex + paragraphs[i].text.length
        }
        return paragraphs.flatMap(paragraph => {

        })
/*
        const phrases: MyPhrase[] = await phonemizer.phonemize(paragraphs[i])
        if (phrases.length) {
          phrases[0].onStart = onParagraph.bind(null, charIndex, charIndex + paragraphs[i].length)
          phrases[phrases.length - 1].silenceSeconds = config.paragraphSilenceSeconds
          yield* phrases
        }

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
*/
      })

      let index = 0
      let playing: Playing|undefined
      let paused: ReturnType<Playing["pause"]>|undefined
      const playItem = function() {
        playing = items[index].play()
        playing.endPromise.then(() => sm.trigger("onNext"), reason => sm.trigger("onError", reason))
      }
      const finishSubject = new rxjs.Subject<void>()

      const sm = makeStateMachine<"PLAYING"|"PAUSED"|"FINISHED", PlaybackCommand|"onNext"|"onError">({
        IDLE: {
          resume() {
            if (index < items.length) {
              items[index].onSelected()
              playItem()
              return "PLAYING"
            }
            else {
              finishSubject.next()
              return "FINISHED"
            }
          }
        },
        PLAYING: {
          pause() {
            if (playing) {
              paused = playing.pause()
              playing = undefined
              return "PAUSED"
            }
          },
          resume() {},
          forward() {
            if (index + 1 < items.length) {
              playing?.pause()
              index++
              items[index].onSelected()
              playItem()
            }
          },
          rewind() {
            if (index > 0) {
              playing?.pause()
              index--
              items[index].onSelected()
              playItem()
            }
          },
          stop() {
            playing?.pause()
            finishSubject.error({name: "interrupted", message: "Playback interrupted"})
            return "FINISHED"
          },
          onNext() {
            if (index + 1 < items.length) {
              index++
              items[index].onSelected()
              playItem()
            }
            else {
              finishSubject.next()
              return "FINISHED"
            }
          },
          onError(reason: unknown) {
            finishSubject.error(reason)
            return "FINISHED"
          }
        },
        PAUSED: {
          pause() {},
          resume() {
            if (paused) {
              playing = paused.resume()
              paused = undefined
              return "PLAYING"
            }
            else {
              playItem()
              return "PLAYING"
            }
          },
          forward() {
            if (index + 1 < items.length) {
              paused = undefined
              index++
              items[index].onSelected()
            }
          },
          rewind() {
            if (index > 0) {
              paused = undefined
              index--
              items[index].onSelected()
            }
          },
          stop() {
            finishSubject.error({name: "interrupted", message: "Playback interrupted"})
            return "FINISHED"
          }
        },
        FINISHED: {
          pause() {},
          resume() {},
          forward() {},
          rewind() {},
          stop() {}
        }
      })

      sm.trigger("resume")
      const sub = control.subscribe(cmd => sm.trigger(cmd))
      try {
        await rxjs.firstValueFrom(finishSubject)
      }
      finally {
        sub.unsubscribe()
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
