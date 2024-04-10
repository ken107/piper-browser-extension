import * as rxjs from "rxjs"
import config from "./config"
import { Phrase } from "./phonemizer"
import { makeSynthesizer } from "./synthesizer"
import { PcmData, PlayAudio } from "./types"
import { lazy, makeBatchProcessor, wait } from "./utils"

interface SpeakOptions {
  readonly speakerId: number|undefined,
  readonly text: string,
  playAudio: PlayAudio
}

type Synthesizer = ReturnType<typeof makeSynthesizer>

interface MyPhrase extends Phrase {
  getPcmData(): Promise<PcmData>
}

interface Sentence {
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
  getPhrases(): Promise<MyPhrase[]>
}

type PlaybackState = rxjs.Observable<"paused"|"resumed">

interface Playing {
  readonly completePromise: Promise<void|boolean>
  pause(): void
  resume(): void
  cancel(): void
  isPaused(): boolean
}


export function makeSpeech(
  synth: Synthesizer,
  opts: SpeakOptions,
  callbacks: {
    onSentence(startIndex: number, endIndex: number): void
  }
) {
  const playlist = makePlaylist(synth, opts, callbacks)
  const control = new rxjs.Subject<"pause"|"resume"|"next"|"forward"|"rewind">()
  return {
    play: lazy(() => new Promise<void>((fulfill, reject) => {
      control
        .pipe(
          rxjs.startWith("next" as const),
          rxjs.scan((current: Playing, cmd) => {
            switch (cmd) {
              case "pause": current.pause(); return current
              case "resume": current.resume(); return current
              case "next": return playlist.next()
              case "forward": return playlist.forward(current.isPaused()) ?? current
              case "rewind": return playlist.rewind(current.isPaused()) ?? current
            }
          }, null!),
          rxjs.distinctUntilChanged(),
          rxjs.switchMap(current => {
            return rxjs.from(current.completePromise)
              .pipe(
                rxjs.finalize(() => current.cancel())
              )
          })
        )
        .subscribe({
          next(isDone) {
            if (isDone) control.complete()
            else control.next("next")
          },
          complete: fulfill,
          error: reject
        })
    })),
    pause() {
      control.next("pause")
    },
    resume() {
      control.next("resume")
    },
    cancel() {
      control.error({name: "CancellationException", message: "Playback cancelled"})
    },
    forward() {
      control.next("forward")
    },
    rewind() {
      control.next("rewind")
    }
  }
}


function makePlaylist(
  synth: Synthesizer,
  opts: SpeakOptions,
  callbacks: {
    onSentence(startIndex: number, endIndex: number): void
  }
) {
  const sentences = makeSentences(synth, opts)
  let sentenceIndex = 0
  let phraseIndex = -1

  return {
    next(): Playing {
      return makePlaying(async playbackState => {
        const phrases = await sentences[sentenceIndex].getPhrases()
        await wait(playbackState, "resumed")

        if (phraseIndex + 1 < phrases.length) {
          //advance to next phrase in current sentence
          phraseIndex++
          if (phraseIndex == 0) callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await playPhrase(opts, sentences, sentenceIndex, phraseIndex, playbackState)
        }
        else if (sentenceIndex + 1 < sentences.length) {
          //advance to next sentence
          sentenceIndex++
          phraseIndex = 0
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await playPhrase(opts, sentences, sentenceIndex, phraseIndex, playbackState)
        }
        else {
          //end of playlist
          return true
        }
      })
    },

    forward(isPaused: boolean): Playing|undefined {
      if (sentenceIndex + 1 < sentences.length) {
        return makePlaying(async playbackState => {
          //advance to next sentence
          sentenceIndex++
          phraseIndex = 0
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playPhrase(opts, sentences, sentenceIndex, phraseIndex, playbackState)
        }, isPaused)
      }
    },

    rewind(isPaused: boolean): Playing|undefined {
      if (sentenceIndex > 0) {
        return makePlaying(async playbackState => {
          //rewind to previous sentence
          sentenceIndex--
          phraseIndex = 0
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playPhrase(opts, sentences, sentenceIndex, phraseIndex, playbackState)
        }, isPaused)
      }
    }
  }
}


function makeSentences(
  synth: Synthesizer,
  opts: SpeakOptions
) {
  /**
   * Hebrew       ׃
   * East Asian   。．
   * Burmese      ။
   * Tibetan      །
   * Arabic       ۔؟
   * Dravidian    ।॥
   */
  const tokens = opts.text.split(/([.?!۔؟]\s+|[\n׃。．။།।॥]\s*)/)

  const sentences = []
  for (let i = 0; i < tokens.length; i += 2)
    sentences.push(tokens[i] + (tokens[i+1] ?? ''))

  const indices = [0]
  for (let i = 0; i < sentences.length; i++)
    indices.push(indices[i] + sentences[i].length)

  const batchPhonemize = makeBatchProcessor(config.phonemizeBatchSize, async (sentences: string[]) => {
    const phonemizer = await synth.phonemizerPromise
    return phonemizer.batchPhonemize(sentences)
  })

  return sentences.map<Sentence>((text, i) => {
    const phonemize = batchPhonemize.add(text, text.length)
    return {
      text,
      startIndex: indices[i],
      endIndex: indices[i+1],
      getPhrases: lazy(async () => {
        const phrases = await phonemize()
        return phrases.map<MyPhrase>((phrase, index) => ({
          phonemeIds: phrase.phonemeIds,
          phonemes: phrase.phonemes,
          silenceSeconds: index == phrases.length-1 && /\n\s*$/.test(text) ? config.paragraphSilenceSeconds : phrase.silenceSeconds,
          getPcmData: lazy(() => synth.synthesize(phrase, opts.speakerId))
        }))
      })
    }
  })
}


function makePlaying(
  synthesizeAndPlay: (playbackState: PlaybackState) => Promise<void|boolean>,
  isPaused = false
): Playing {
  const playbackState = new rxjs.BehaviorSubject<"paused"|"resumed">(isPaused ? "paused" : "resumed")
  return {
    completePromise: synthesizeAndPlay(playbackState.asObservable()),
    pause() {
      playbackState.next("paused")
    },
    resume() {
      playbackState.next("resumed")
    },
    cancel() {
      playbackState.error({name: "CancellationException", message: "Playback cancelled"})
    },
    isPaused() {
      return playbackState.getValue() == "paused"
    }
  }
}


async function playPhrase(
  opts: SpeakOptions,
  sentences: Sentence[],
  sentenceIndex: number,
  phraseIndex: number,
  playbackState: PlaybackState,
) {
  prefetch(sentences, sentenceIndex, phraseIndex, playbackState)
    .catch(err => err.name != "CancellationException" && console.error(err))

  const phrases = await sentences[sentenceIndex].getPhrases()
  await wait(playbackState, "resumed")

  if (phraseIndex < phrases.length) {
    const pcmData = await phrases[phraseIndex].getPcmData()
    await wait(playbackState, "resumed")

    let playing = opts.playAudio(pcmData, phrases[phraseIndex].silenceSeconds)
    try {
      while (await Promise.race([wait(playbackState, "paused"), playing.completePromise]) == "paused") {
        const paused = playing.pause()
        await wait(playbackState, "resumed")
        playing = paused.resume()
      }
    }
    finally {
      playing.pause()
    }
  }
}


async function prefetch(
  sentences: Sentence[],
  sentenceIndex: number,
  phraseIndex: number,
  playbackState: PlaybackState
) {
  let numPhonemesToPrefetch = config.numPhonemesToPrefetch

  //get the phrases of the current sentence
  let phrases = await sentences[sentenceIndex].getPhrases()
  await wait(playbackState, "resumed")

  if (phraseIndex < phrases.length) {
    //wait until the current phrase has been synthesized before prefetching
    await phrases[phraseIndex].getPcmData()
    await wait(playbackState, "resumed")
  }

  while (numPhonemesToPrefetch > 0) {
    if (phraseIndex + 1 < phrases.length) {
      //advance to the next phrase in the current sentence
      phraseIndex++
    }
    else if (sentenceIndex + 1 < sentences.length) {
      //advance to the next sentence
      sentenceIndex++
      phraseIndex = 0

      //get the phrases
      phrases = await sentences[sentenceIndex].getPhrases()
      await wait(playbackState, "resumed")
    }
    else {
      break
    }

    if (phraseIndex < phrases.length) {
      //prefetch the phrase
      await phrases[phraseIndex].getPcmData()
      await wait(playbackState, "resumed")

      numPhonemesToPrefetch -= phrases[phraseIndex].phonemes.length
    }
  }
}
