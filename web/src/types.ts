
export interface MyVoice {
  id: string
  lang: string
  stylePath: string
}

export interface Installable {
  url: string
  size: number|null
}

export type LoadState = {
  type: "not-installed"|"installed"|"loading"|"loaded"|"in-use"
} | {
  type: "installing"
  progress: string
}

export interface PcmData {
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly numChannels: number
}

export interface PlayAudio {
  (pcmData: PcmData, appendSilenceSeconds: number): AudioPlaying
}

interface AudioPlaying {
  readonly completePromise: Promise<void>
  pause(): {
    resume(): AudioPlaying
  }
}
