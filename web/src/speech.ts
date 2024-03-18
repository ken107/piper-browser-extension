import * as rxjs from "rxjs"
import { playAudio } from "./audio"
import { Phrase } from "./phonemizer"
import { makeSynthesizer } from "./synthesizer"
import { PcmData } from "./types"
import { makeExposedPromise, wait } from "./utils"

interface SpeakOptions {
  speakerId: number|undefined,
  text: string,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined
}

type Synthesizer = ReturnType<typeof makeSynthesizer>

interface MyPhrase extends Phrase {
  pcmDataPromise?: Promise<PcmData>
}

interface Paragraph {
  text: string
  startIndex: number
  endIndex: number
  phrasesPromise?: Promise<MyPhrase[]>
}

type PlaybackState = rxjs.Observable<"paused"|"resumed">

interface Playing {
  completePromise: Promise<void|boolean>
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
  const paras = splitParagraphs(opts.text)
  let paraIndex = 0
  let phraseIndex = -1

  return {
    next(): Playing {
      return makePlaying(async playbackState => {
        const phrases = await getPhrases(synth, paras[paraIndex], playbackState)
        await wait(playbackState, "resumed")
        if (phraseIndex + 1 < phrases.length) {
          phraseIndex++
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState)
        }
        else if (paraIndex + 1 < paras.length) {
          paraIndex++
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState)
        }
        else {
          return true   //end of playlist
        }
      })
    },

    forward(): Playing|undefined {
      if (paraIndex + 1 < paras.length) {
        return makePlaying(async playbackState => {
          paraIndex++
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          const phrases = await getPhrases(synth, paras[paraIndex], playbackState)
          await wait(playbackState, "resumed")
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState)
        })
      }
    },

    rewind(): Playing|undefined {
      if (paraIndex > 0) {
        return makePlaying(async playbackState => {
          paraIndex--
          phraseIndex = 0
          callbacks.onParagraph(paras[paraIndex].startIndex, paras[paraIndex].endIndex)
          const phrases = await getPhrases(synth, paras[paraIndex], playbackState)
          await wait(playbackState, "resumed")
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState)
        })
      }
    }
  }
}


function splitParagraphs(text: string): Paragraph[] {
  const tokens = text.split(/(\n\n\s*)/)
  const paragraphs = []
  for (let i = 0; i < tokens.length; i += 2) paragraphs.push(tokens[i] + (tokens[i+1] ?? ''))
  const indices = [0]
  for (let i = 0; i < paragraphs.length; i++) indices.push(indices[i] + paragraphs[i].length)
  return paragraphs
    .map((text, i) => ({
      text,
      startIndex: indices[i],
      endIndex: indices[i+1]
    }))
}


async function getPhrases(
  synth: Synthesizer,
  para: Paragraph,
  playbackState: PlaybackState
) {
  if (!para.phrasesPromise) {
    const phonemizer = await synth.phonemizerPromise
    await wait(playbackState, "resumed")
    para.phrasesPromise = phonemizer.phonemize(para.text)
  }
  return para.phrasesPromise
}


async function playPhrase(
  synth: Synthesizer,
  opts: SpeakOptions,
  phrase: MyPhrase,
  playbackState: PlaybackState
) {
  if (!phrase.pcmDataPromise) phrase.pcmDataPromise = synth.synthesize(phrase, opts.speakerId)
  const pcmData = await phrase.pcmDataPromise
  await wait(playbackState, "resumed")
  let playing = playAudio(pcmData, phrase.silenceSeconds, opts.pitch, opts.rate, opts.volume)
  while (await Promise.race([wait(playbackState, "paused"), playing.completePromise]) == "paused") {
    const paused = playing.pause()
    await wait(playbackState, "resumed")
    playing = paused.resume()
  }
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
