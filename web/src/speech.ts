import * as rxjs from "rxjs"
import config from "./config"
import { makeSynthesizer } from "./synthesizer"
import { PcmData, PlayAudio } from "./types"
import { lazy, wait } from "./utils"

interface SpeakOptions {
  readonly text: string,
  readonly voiceId: string
  readonly numSteps: number
  playAudio: PlayAudio
}

type Synthesizer = ReturnType<typeof makeSynthesizer>

interface Sentence {
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
  readonly silenceSeconds: number
  getPcmData(): Promise<PcmData>
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
  const sentences = makeSentences(synth, opts)
  const playlist = makePlaylist(sentences, opts, callbacks)
  const control = new rxjs.Subject<"pause"|"resume"|"next"|"forward"|"rewind"|number>()
  return {
    sentenceStartIndicies: sentences.map(sentence => sentence.startIndex),
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
              default: return playlist.seek(cmd, current.isPaused()) ?? current
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
    },
    seek(index: number) {
      control.next(index)
    }
  }
}


function makePlaylist(
  sentences: Sentence[],
  opts: SpeakOptions,
  callbacks: {
    onSentence(startIndex: number, endIndex: number): void
  }
) {
  let sentenceIndex = -1

  return {
    next(): Playing {
      return makePlaying(async playbackState => {
        if (sentenceIndex + 1 < sentences.length) {
          //advance to next sentence
          sentenceIndex++
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await playSentence(opts, sentences, sentenceIndex, playbackState)
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
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playSentence(opts, sentences, sentenceIndex, playbackState)
        }, isPaused)
      }
    },

    rewind(isPaused: boolean): Playing|undefined {
      if (sentenceIndex > 0) {
        return makePlaying(async playbackState => {
          //rewind to previous sentence
          sentenceIndex--
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playSentence(opts, sentences, sentenceIndex, playbackState)
        }, isPaused)
      }
    },

    seek(index: number, isPaused: boolean): Playing|undefined {
      if (index >= 0 && index < sentences.length) {
        return makePlaying(async playbackState => {
          sentenceIndex = index
          callbacks.onSentence(sentences[sentenceIndex].startIndex, sentences[sentenceIndex].endIndex)
          await playSentence(opts, sentences, sentenceIndex, playbackState)
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
  for (let i = 0; i < tokens.length; i += 2) {
    if (/\b(\w|[A-Z][a-z]|Dept|[Ee]tc|Gov|Inc|Ltd|Mrs|Rev|Sra|vs)\.\s+$/.test(sentences[sentences.length-1]))
      sentences[sentences.length-1] += tokens[i] + (tokens[i+1] ?? '')
    else
      sentences.push(tokens[i] + (tokens[i+1] ?? ''))
  }

  const indices = [0]
  for (let i = 0; i < sentences.length; i++)
    indices.push(indices[i] + sentences[i].length)

  return sentences.map<Sentence>((text, i) => {
    return {
      text,
      startIndex: indices[i],
      endIndex: indices[i+1],
      silenceSeconds: /\n\s*$/.test(text) ? config.paragraphSilenceSeconds : config.sentenceSilenceSeconds,
      getPcmData: lazy(() => synth.synthesize(text, opts.voiceId, opts.numSteps))
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


async function playSentence(
  opts: SpeakOptions,
  sentences: Sentence[],
  sentenceIndex: number,
  playbackState: PlaybackState,
) {
  prefetch(sentences, sentenceIndex, playbackState)
    .catch(err => err.name != "CancellationException" && console.error(err))

  const pcmData = await sentences[sentenceIndex].getPcmData()
  await wait(playbackState, "resumed")

  let playing = opts.playAudio(pcmData, sentences[sentenceIndex].silenceSeconds)
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


async function prefetch(
  sentences: Sentence[],
  sentenceIndex: number,
  playbackState: PlaybackState
) {
  let numPhonemesToPrefetch = config.numPhonemesToPrefetch

  //wait until the current phrase has been synthesized before prefetching
  await sentences[sentenceIndex].getPcmData()
  await wait(playbackState, "resumed")

  while (numPhonemesToPrefetch > 0 && sentenceIndex + 1 < sentences.length) {
    //advance to the next sentence
    sentenceIndex++

    //prefetch the phrase
    await sentences[sentenceIndex].getPcmData()
    await wait(playbackState, "resumed")

    numPhonemesToPrefetch -= sentences[sentenceIndex].text.length
  }
}
