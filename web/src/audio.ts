import { WaveFile } from "wavefile"
import { PcmData } from "./types"

const audio = new Audio()


export function playAudio(
  {numChannels, sampleRate, samples}: PcmData,
  appendSilenceSeconds: number,
  pitch: number|undefined,
  rate: number|undefined,
  volume: number|undefined
) {
  const samplesWithSilence = new Float32Array(samples.length + appendSilenceSeconds * sampleRate * numChannels)
  samplesWithSilence.set(samples)

  const waveFile = new WaveFile()
  waveFile.fromScratch(numChannels, sampleRate, "32f", samplesWithSilence)
  const waveBlob = new Blob([waveFile.toBuffer()], {type: "audio/wav"})

  audio.src = URL.createObjectURL(waveBlob)
  audio.playbackRate = rate ?? 1
  audio.volume = volume ?? 1

  const endPromise = new Promise<void>((fulfill, reject) => {
    audio.onended = () => fulfill()
    audio.onerror = () => reject(new Error("Failed to load audio"))
  })

  const playing = {
    completePromise: audio.play().then(() => endPromise),
    pause() {
      audio.pause()
      return {
        resume() {
          audio.play()
          return playing
        }
      }
    }
  }

  return playing
}
