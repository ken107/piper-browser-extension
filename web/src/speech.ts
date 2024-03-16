import * as rxjs from "rxjs"
import { PlaybackCommand, PlaybackState } from "./types"
import { makeSynthesizer } from "./synthesizer"


export function makeSpeech(
  synth: ReturnType<typeof makeSynthesizer>,
  speakerId: number|undefined,
  utterance: string,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined,
) {
  const control = new rxjs.Subject<PlaybackCommand>()
  const playbackStateObs = control
    .pipe(
      rxjs.scan((state: PlaybackState, cmd) => {
        if (cmd == "stop") throw {name: "interrupted", message: "Playback interrupted"}
        if (state == "resumed" && cmd == "pause") return "paused"
        if (state == "paused" && cmd == "resume") return "resumed"
        return state
      }, "resumed"),
      rxjs.startWith("resumed" as const),
      rxjs.distinctUntilChanged(),
      rxjs.shareReplay({bufferSize: 1, refCount: false})
    )
  const statusSubject = new rxjs.Subject<{type: "paragraph", startIndex: number, endIndex: number}>()

/*
  return {
    async speak(
      {speakerId, utterance, pitch, rate, volume}: SpeakOptions,
      control: rxjs.Observable<PlaybackCommand>,
      playbackState: rxjs.Observable<PlaybackState>,
      {onSentence, onParagraph}: {
        onSentence(startIndex: number, endIndex: number): void
        onParagraph(startIndex: number, endIndex: number): void
      }
    ) {
      const phrases = immediate(async function*() {
        const paragraphs = splitParagraphs(utterance)
          .map(text => ({text, startIndex: 0, endIndex: 0}))
        for (let i = 0, charIndex = 0; i < paragraphs.length; charIndex += paragraphs[i].text.length, i++) {
          paragraphs[i].startIndex = charIndex
          paragraphs[i].endIndex = charIndex + paragraphs[i].text.length
        }

        const phrases: MyPhrase[] = await phonemizer.phonemize(paragraphs[i])
        if (phrases.length) {
          phrases[0].onStart = onParagraph.bind(null, charIndex, charIndex + paragraphs[i].length)
          phrases[phrases.length - 1].silenceSeconds = config.paragraphSilenceSeconds
          yield* phrases
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

      await playPlaylist(head, control)
    },
*/

  return {
    control,
    statusObs: statusSubject.asObservable()
  }
}


function splitParagraphs(text: string) {
  const tokens = text.split(/(\n\n\s*)/)
  const paragraphs = []
  for (let i = 0; i < tokens.length; i += 2) paragraphs.push(tokens[i] + (tokens[i+1] ?? ''))
  return paragraphs
}
