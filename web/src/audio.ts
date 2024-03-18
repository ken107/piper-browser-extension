import { PcmData } from "./types"
import { lazy } from "./utils"

const getAudioCtx = lazy(() => new AudioContext())


export function playAudio(
  pcmData: PcmData,
  appendSilenceSeconds: number,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined
) {
  const audioCtx = getAudioCtx()
  const {buffer, peak} = makeAudioBuffer(audioCtx, pcmData, appendSilenceSeconds)

  const gainNode = audioCtx.createGain()
  gainNode.gain.value = (volume ?? 1) / Math.max(.01, peak)
  gainNode.connect(audioCtx.destination)

  return play(audioCtx, gainNode, buffer, rate ?? 1, 0)
}


function play(
  audioCtx: AudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  rate: number,
  startOffset: number
) {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  source.playbackRate.value = rate
  const completePromise = new Promise<void>(f => source.onended = () => f())

  source.connect(destination)
  source.start(0, startOffset)
  const startTime = audioCtx.currentTime - startOffset

  return {
    completePromise,
    pause() {
      source.onended = null
      source.stop()
      source.disconnect()
      const pauseOffset = audioCtx.currentTime - startTime

      return {
        resume() {
          return play(audioCtx, destination, buffer, rate, pauseOffset)
        }
      }
    }
  }
}


function makeAudioBuffer(
  audioCtx: AudioContext,
  {samples, sampleRate, numChannels}: PcmData,
  appendSilenceSeconds: number
) {
  const samplesPerChannel = samples.length / numChannels
  const buffer = audioCtx.createBuffer(numChannels, samplesPerChannel + (appendSilenceSeconds * sampleRate), sampleRate)
  let peak = 0

  for (let channel = 0; channel < numChannels; channel++) {
    const nowBuffering = buffer.getChannelData(channel)

    for (let i = 0; i < samplesPerChannel; i++) {
      const sample = samples[i * numChannels + channel]   //assuming interleaved channel data
      nowBuffering[i] = sample
      if (sample > peak) peak = sample
      else if (-sample > peak) peak = -sample
    }
  }

  return {buffer, peak}
}
