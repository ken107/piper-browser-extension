import * as rxjs from "rxjs"
import { playAudio } from "./audio"
import { Phrase } from "./phonemizer"
import { makeSynthesizer } from "./synthesizer"
import { PcmData } from "./types"
import { lazy, makeExposedPromise, wait } from "./utils"

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
  const completePromise = makeExposedPromise<void>()
  let current: Playing|undefined = playlist.next()
  current.completePromise.then(onItemComplete, onItemError)

  function onItemComplete(isEndOfPlaylist: void|boolean) {
    if (isEndOfPlaylist) {
      completePromise.fulfill()
    }
    else {
      current = playlist.next()
      current.completePromise.then(onItemComplete, onItemError)
    }
  }
  function onItemError(reason: unknown) {
    completePromise.reject(reason)
  }

  return {
    completePromise: completePromise.promise,
    pause() {
      current?.pause()
    },
    resume() {
      current?.resume()
    },
    cancel() {
      current?.cancel()
      current = undefined
    },
    forward() {
      const playing = playlist.forward()
      if (playing) {
        current?.cancel()
        current = playing
        current.completePromise.then(onItemComplete, onItemError)
      }
    },
    rewind() {
      const playing = playlist.rewind()
      if (playing) {
        current?.cancel()
        current = playing
        current.completePromise.then(onItemComplete, onItemError)
      }
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
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState, callbacks)
        }
        else if (paraIndex + 1 < paras.length) {
          //advance to next paragraph
          paraIndex++
          phraseIndex = 0
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState, callbacks)
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
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState, callbacks)
        })
      }
    },

    rewind(): Playing|undefined {
      if (paraIndex > 0) {
        return makePlaying(async playbackState => {
          //rewind to previous paragraph
          paraIndex--
          phraseIndex = 0
          await playPhrase(opts, paras, paraIndex, phraseIndex, playbackState, callbacks)
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
      return phrases.map<MyPhrase>(phrase => ({
        ...phrase,
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
  callbacks: {
    onParagraph(startIndex: number, endIndex: number): void
  }
) {
  if (phraseIndex == 0)
    callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)

  prefetch(paras, paraIndex, phraseIndex, playbackState)

  const phrases = await paras[paraIndex].getPhrases()
  await wait(playbackState, "resumed")

  const pcmData = await phrases[phraseIndex].getPcmData()
  await wait(playbackState, "resumed")

  let playing = playAudio(pcmData, phrases[phraseIndex].silenceSeconds, opts.pitch, opts.rate, opts.volume)
  while (await Promise.race([wait(playbackState, "paused"), playing.completePromise]) == "paused") {
    const paused = playing.pause()
    await wait(playbackState, "resumed")
    playing = paused.resume()
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
