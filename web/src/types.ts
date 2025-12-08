
export interface MyVoice {
  readonly id: string
  readonly lang: string
  readonly stylePath: string
}

export type LoadState = {
  readonly type: "not-installed"|"installed"|"loading"|"loaded"|"in-use"
} | {
  readonly type: "installing"
  readonly progress: string
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
