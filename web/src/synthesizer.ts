import { makeDispatcher } from "@lsdsoftware/message-dispatcher"
import * as rxjs from "rxjs"
import config from "./config"
import { Phrase, makePhonemizer } from "./phonemizer"
import { playAudio } from "./player"
import { ModelConfig, PcmData, SpeakOptions } from "./types"
import { immediate, ExecutionSignal } from "./utils"


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


async function synthesize(
  engineId: string,
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


interface PlaylistItem {
  paragraphIndex: number
  play(executionSignal: ExecutionSignal): Promise<void>
}


export async function makeSynthesizer(model: Blob, modelConfig: ModelConfig) {
  const phonemizer = makePhonemizer(modelConfig)
  const engineId = await worker.request("makeInferenceEngine", {model, modelConfig})

  return {
    async speak(
      {speakerId, utterance, pitch, rate, volume}: SpeakOptions,
      executionSignal: ExecutionSignal,
      playlistNav: rxjs.Observable<"forward"|"rewind">,
      {onSentence, onParagraph}: {
        onSentence(startIndex: number, endIndex: number): void
        onParagraph(startIndex: number, endIndex: number): void
      }
    ) {
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

      await playPlaylist(items, executionSignal, playlistNav)
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


function playPlaylist(
  items: PlaylistItem[],
  executionSignal: ExecutionSignal,
  playlistNav: rxjs.Observable<"forward"|"rewind">
) {
  return new Promise<void>((fulfill, reject) => {
    const nextSubject = new rxjs.Subject<"next">()
    rxjs.merge(nextSubject, playlistNav)
      .pipe(
        rxjs.startWith("next" as const),
        rxjs.scan((index, cmd) => {
          if (index == null) {
            if (0 < items.length) return 0
            else return null
          }
          switch (cmd) {
            case "next":
              if (index + 1 < items.length) return index + 1
              else return null
            case "forward":
              for (let i = index + 1; i < items.length; i++) {
                if (items[i].paragraphIndex == items[index].paragraphIndex + 1) return i
              }
              return index
            case "rewind":
              for (let i = 0; i < items.length; i++) {
                if (items[i].paragraphIndex == items[index].paragraphIndex - 1) return i
              }
              return index
          }
        }, null as number|null),
        rxjs.takeWhile(index => index != null),
        rxjs.distinctUntilChanged(),
        rxjs.switchMap(index => {
          let abort: (reason: unknown) => void
          const abortPromise = new Promise<void>((f, r) => abort = r)
          const endPromise = items[index!].play({
            paused: () => Promise.race([abortPromise, executionSignal.paused()]),
            resumed: () => Promise.race([abortPromise, executionSignal.resumed()])
          })
          return rxjs.from(endPromise).pipe(
            rxjs.finalize(() => abort({name: "interrupted", message: "Playback interrupted 3"}))
          )
        })
      )
      .subscribe({
        next() {
          nextSubject.next("next")
        },
        complete: fulfill,
        error: reject
      })
  })
}
