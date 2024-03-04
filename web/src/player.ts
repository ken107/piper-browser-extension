import * as rxjs from "rxjs"
import { PcmData } from "./types"
import { lazy } from "./utils"

const getAudioCtx = lazy(() => new AudioContext())


export async function playAudio(
  pcmData: PcmData,
  appendSilenceSeconds: number,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined,
  control: rxjs.Observable<"play"|"pause"|"stop">
) {
  const audioCtx = getAudioCtx()
  const {buffer, peak} = makeAudioBuffer(audioCtx, pcmData, appendSilenceSeconds)

  const gainNode = audioCtx.createGain()
  gainNode.gain.value = (volume ?? 1) / Math.max(.01, peak)
  gainNode.connect(audioCtx.destination)

  let startTime: number
  let pauseOffset = 0
  let command: "play"|"pause"|"stop"|"ended"

  do {
    command = await rxjs.firstValueFrom(control.pipe(rxjs.filter(x => x != "pause")))

    if (command == "play") {
      const source = audioCtx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate ?? 1
      const endPromise = new Promise<"ended">(f => source.onended = () => f("ended"))
      source.connect(gainNode)
      source.start(0, pauseOffset)
      startTime = audioCtx.currentTime - pauseOffset

      command = await Promise.race([
        rxjs.firstValueFrom(control.pipe(rxjs.filter(x => x == "pause" || x == "stop"))),
        endPromise
      ])

      source.stop()
      source.disconnect()
      pauseOffset = audioCtx.currentTime - startTime
    }
  }
  while (command == "pause")
}


function makeAudioBuffer(
  audioCtx: AudioContext,
  {samples, sampleRate, numChannels}: PcmData,
  appendSilenceSeconds: number
): {
  buffer: AudioBuffer,
  peak: number
} {
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
