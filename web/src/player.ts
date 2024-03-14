import { PcmData } from "./types"
import { ExecutionSignal, lazy } from "./utils"

const getAudioCtx = lazy(() => new AudioContext())


export async function playAudio(
  pcmData: PcmData,
  appendSilenceSeconds: number,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined,
  executionSignal: ExecutionSignal,
) {
  const audioCtx = getAudioCtx()
  const {buffer, peak} = makeAudioBuffer(audioCtx, pcmData, appendSilenceSeconds)

  const gainNode = audioCtx.createGain()
  gainNode.gain.value = (volume ?? 1) / Math.max(.01, peak)
  gainNode.connect(audioCtx.destination)

  let pauseOffset = 0
  while (true) {
    await executionSignal.resumed()
    const {endPromise, pause} = play(audioCtx, gainNode, buffer, rate ?? 1, pauseOffset)
    try {
      const action: "stop"|"pause" = await Promise.race([
        endPromise.then(() => "stop" as const),
        executionSignal.paused().then(() => "pause" as const)
      ])
      if (action == "stop") break
    }
    finally {
      pauseOffset = pause()
    }
  }
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
  const endPromise = new Promise(f => source.onended = f)

  source.connect(destination)
  source.start(0, startOffset)
  const startTime = audioCtx.currentTime - startOffset

  return {
    endPromise,
    pause() {
      source.onended = null
      source.stop()
      source.disconnect()
      return audioCtx.currentTime - startTime
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
