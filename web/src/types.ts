import * as rxjs from "rxjs"

export interface PiperVoice {
  readonly key: string
  readonly name: string
  readonly language: {
    readonly code: string
    readonly family: string
    readonly region: string
    readonly name_native: string
    readonly name_english: string
    readonly country_english: string
  }
  readonly quality: string
  readonly num_speakers: number
  readonly speaker_id_map: Record<string, number>
  readonly files: Record<string, {
    readonly size_bytes: number
    readonly md5_digest: string
  }>
  readonly aliases: string[]
}

export interface MyVoice extends PiperVoice {
  readonly modelFile: string
  readonly modelFileSize: number
  readonly installState: InstallState
}

export interface AdvertisedVoice {
  readonly voiceName: string
  readonly lang: string
  readonly eventTypes: string[]
}

export type InstallState = "not-installed"|"installing"|"installed"

export interface Synthesizer {
  readonly isBusy: boolean
  makeSpeech(opts: SpeakOptions): Speech
}

export interface ModelConfig {
  audio?: {
    sample_rate?: number
  }
  espeak?: {
    voice?: string
  }
  inference?: {
    noise_scale?: number
    length_scale?: number
    noise_w?: number
    phoneme_silence?: Record<string, number>
  }
  phoneme_type?: string
  phoneme_map?: Record<string, string[]>
  phoneme_id_map?: Record<string, number[]>
}

export interface SpeakOptions {
  speakerId?: number,
  utterance: string,
  pitch?: number,
  rate?: number,
  volume?: number
}

export interface Speech {
  control: rxjs.Subject<"play"|"pause"|"stop">
  readyPromise: Promise<void>
  finishPromise: Promise<void>
}

export interface PcmData {
  samples: Float32Array
  sampleRate: number
  numChannels: number
}
