import * as rxjs from "rxjs"
import { playAudio } from "./audio"
import config from "./config"
import { Phrase } from "./phonemizer"
import { makeSynthesizer } from "./synthesizer"
import { PcmData } from "./types"
import { lazy, wait } from "./utils"

interface SpeakOptions {
  readonly speakerId: number|undefined,
  readonly text: string,
  readonly pitch: number|undefined,
  readonly rate: number|undefined,
  readonly volume: number|undefined
}

type Synthesizer = ReturnType<typeof makeSynthesizer>

interface MyPhrase extends Phrase {
  getPcmData(): Promise<PcmData>
}

interface Paragraph {
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
}


export function makeSpeech(
  synth: Synthesizer,
  opts: SpeakOptions,
  callbacks: {
    onParagraph(startIndex: number, endIndex: number): void
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
              case "forward": return playlist.forward() ?? current
              case "rewind": return playlist.rewind() ?? current
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
      control.error({name: "interrupted", message: "Playback interrupted"})
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
    onParagraph(startIndex: number, endIndex: number): void
  }
) {
  const paras = makeParagraphs(synth, opts)
  let paraIndex = 0
  let phraseIndex = -1

  return {
    next(): Playing {
      return makePlaying(async playbackState => {
        const phrases = await paras[paraIndex].getPhrases()
        await wait(playbackState, "resumed")

        if (phraseIndex + 1 < phrases.length) {
          //advance to next phrase in current paragraph
          phraseIndex++
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState)
        }
        else if (paraIndex + 1 < paras.length) {
          //advance to next paragraph
          paraIndex++
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState)
        }
        else {
          //end of playlist
          return true
        }
      })
    },

    forward(): Playing|undefined {
      if (paraIndex + 1 < paras.length) {
        return makePlaying(async playbackState => {
          //advance to next paragraph
          paraIndex++
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState)
        })
      }
    },

    rewind(): Playing|undefined {
      if (paraIndex > 0) {
        return makePlaying(async playbackState => {
          //rewind to previous paragraph
          paraIndex--
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          await new Promise<void>(f => setTimeout(f, 750))
          await wait(playbackState, "resumed")
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState)
        })
      }
    }
  }
}


function makeParagraphs(
  synth: Synthesizer,
  opts: SpeakOptions
) {
  const tokens = opts.text.split(/(\n\s*)/)

  const paragraphs = []
  for (let i = 0; i < tokens.length; i += 2)
    paragraphs.push(tokens[i] + (tokens[i+1] ?? ''))

  const indices = [0]
  for (let i = 0; i < paragraphs.length; i++)
    indices.push(indices[i] + paragraphs[i].length)

  return paragraphs.map<Paragraph>((text, i) => ({
    text,
    startIndex: indices[i],
    endIndex: indices[i+1],
    getPhrases: lazy(async () => {
      const phrases = await synth.phonemizerPromise.then(x => x.phonemize(text))
      return phrases.map<MyPhrase>((phrase, index) => ({
        phonemeIds: phrase.phonemeIds,
        phonemes: phrase.phonemes,
        silenceSeconds: index == phrases.length-1 ? config.paragraphSilenceSeconds : phrase.silenceSeconds,
        getPcmData: lazy(() => synth.synthesize(phrase, opts.speakerId))
      }))
    })
  }))
}


function makePlaying(
  synthesizeAndPlay: (playbackState: PlaybackState) => Promise<void|boolean>
): Playing {
  const playbackState = new rxjs.BehaviorSubject<"paused"|"resumed">("resumed")
  return {
    completePromise: synthesizeAndPlay(playbackState.asObservable()),
    pause() {
      playbackState.next("paused")
    },
    resume() {
      playbackState.next("resumed")
    },
    cancel() {
      playbackState.error({name: "interrupted", message: "Playback interrupted"})
    },
  }
}


async function playPhrase(
  opts: SpeakOptions,
  paras: Paragraph[],
  paraIndex: number,
  phraseIndex: number,
  playbackState: PlaybackState,
) {
  prefetch(paras, paraIndex, phraseIndex, playbackState)
    .catch(err => "OK")

  const phrases = await paras[paraIndex].getPhrases()
  await wait(playbackState, "resumed")

  const pcmData = await phrases[phraseIndex].getPcmData()
  await wait(playbackState, "resumed")

  let playing = playAudio(pcmData, phrases[phraseIndex].silenceSeconds, opts.pitch, opts.rate, opts.volume)
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
  paras: Paragraph[],
  paraIndex: number,
  phraseIndex: number,
  playbackState: PlaybackState
) {
  let numPhonemesToPrefetch = 100

  //get the phrases of the current paragraph
  let phrases = await paras[paraIndex].getPhrases()
  await wait(playbackState, "resumed")

  //wait until the current phrase has been synthesized before prefetching
  await phrases[phraseIndex].getPcmData()
  await wait(playbackState, "resumed")

  while (numPhonemesToPrefetch > 0) {
    if (phraseIndex + 1 < phrases.length) {
      //advance to the next phrase in the current paragraph
      phraseIndex++
    }
    else if (paraIndex + 1 < paras.length) {
      //advance to the next paragraph
      paraIndex++
      phraseIndex = 0

      //get the phrases
      phrases = await paras[paraIndex].getPhrases()
      await wait(playbackState, "resumed")
    }
    else {
      break
    }

    //prefetch the phrase
    await phrases[phraseIndex].getPcmData()
    await wait(playbackState, "resumed")

    numPhonemesToPrefetch -= phrases[phraseIndex].phonemes.length
  }
}
