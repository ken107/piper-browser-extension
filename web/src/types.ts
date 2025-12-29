
export interface Voice {
  id: string
  name: string
  language: string
  gender: string
}

export interface AdvertisedVoice {
  readonly voiceName: string
  readonly lang: string
  readonly eventTypes: string[]
}

export type ModelStatus = {
  status: "unloaded"
} | {
  status: "loading"
  percent: number
} | {
  status: "ready"
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

export type ModelQuantization = 'q8' | 'q4' | 'q4f16' | 'fp16' | 'fp32'
export type ModelDevice = 'wasm' | 'webgpu'

export interface ModelSettings {
  quantization: ModelQuantization
  device: ModelDevice
}
