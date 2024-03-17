import * as rxjs from "rxjs"
import { Phrase } from "./phonemizer"
import { playAudio } from "./player"
import { makeSynthesizer } from "./synthesizer"
import { PcmData } from "./types"
import { wait } from "./utils"

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
  index: number
  text: string
  phrasesPromise?: Promise<MyPhrase[]>
}

type PlaybackState = rxjs.Observable<"paused"|"resumed">

interface Playing {
  pause(): void
  resume(): void
  cancel(): void
}


export function makeSpeech(
  synth: Synthesizer,
  opts: SpeakOptions,
  callbacks: {
    onParagraph(startIndex: number, endIndex: number): void
    onComplete(error: unknown): void
  }
) {
  const playlist = makePlaylist(synth, opts, callbacks)
  let current: Playing|undefined = playlist.next(onEnd)
  function onEnd() {
    current = playlist.next(onEnd)
  }
  return {
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
      const playing = playlist.forward(onEnd)
      if (playing) {
        current?.cancel()
        current = playing
      }
    },
    rewind() {
      const playing = playlist.rewind(onEnd)
      if (playing) {
        current?.cancel()
        current = playing
      }
    },
  }
}


function makePlaylist(
  synth: Synthesizer,
  opts: SpeakOptions,
  playlistCallbacks: {
    onParagraph(startIndex: number, endIndex: number): void
    onComplete(error: unknown): void
  }
) {
  const paras = splitParagraphs(opts.text).map((text, index) => ({index, text}))
  let paraIndex = 0
  let phraseIndex = -1

  return {
    next(onComplete: () => void): Playing {
      return makePlaying(async playbackState => {
        const phrases = await getPhrases(synth, paras[paraIndex], playbackState)
        await wait(playbackState, "resumed")
        if (phraseIndex + 1 < phrases.length) {
          phraseIndex++
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState, onComplete)
        }
        else if (paraIndex + 1 < paras.length) {
          paraIndex++
          phraseIndex = 0
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState, onComplete)
        }
        else {
          playlistCallbacks.onComplete(null)
        }
      })
    },

    forward(onComplete: () => void): Playing {
      return makePlaying(async playbackState => {
        if (paraIndex + 1 < paras.length) {
          paraIndex++
          phraseIndex = 0
          const phrases = await getPhrases(synth, paras[paraIndex], playbackState)
          await wait(playbackState, "resumed")
          await playPhrase(synth, opts, phrases[phraseIndex], playbackState, onComplete)
        }
        else {
          playlistCallbacks.onComplete(null)
        }
      })
    },

    rewind(onComplete: () => void): Playing {
      return makePlaying(async playbackState => {
        //TODO
      })
    }
  }
}


function splitParagraphs(text: string) {
  const tokens = text.split(/(\n\n\s*)/)
  const paragraphs = []
  for (let i = 0; i < tokens.length; i += 2) paragraphs.push(tokens[i] + (tokens[i+1] ?? ''))
  return paragraphs
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
  playbackState: PlaybackState,
  onComplete: () => void
) {
  if (!phrase.pcmDataPromise) phrase.pcmDataPromise = synth.synthesize(phrase, opts.speakerId)
  const pcmData = await phrase.pcmDataPromise
  await wait(playbackState, "resumed")
  let playing = playAudio(pcmData, phrase.silenceSeconds, opts.pitch, opts.rate, opts.volume, {onComplete})
  while (true) {
    await wait(playbackState, "paused")
    const paused = playing.pause()
    await wait(playbackState, "resumed")
    playing = paused.resume()
  }
}


function makePlaying(
  synthesizeAndPlay: (playbackState: PlaybackState) => Promise<void>
) {
  const playbackState = new rxjs.BehaviorSubject<"paused"|"resumed">("resumed")
  synthesizeAndPlay(playbackState.asObservable())
  return {
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
