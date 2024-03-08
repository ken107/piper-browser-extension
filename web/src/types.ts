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
  readonly loadState: LoadState
  readonly numActiveUsers: number
}

export interface AdvertisedVoice {
  readonly voiceName: string
  readonly lang: string
  readonly eventTypes: string[]
}

export type InstallState = "not-installed"|"installing"|"installed"
export type LoadState = "not-loaded"|"loading"|"loaded"

export type PlaybackState = "play"|"pause"|"stop"

export interface PlaybackControl {
  getState(): PlaybackState
  setState(state: PlaybackState): void
  wait(condition: (state: PlaybackState) => boolean): Promise<PlaybackState>
}

export interface Synthesizer {
  speak(
    opts: SpeakOptions,
    control: PlaybackControl,
    callbacks: {
      onSentenceBoundary(charIndex: number): void
    }
  ): Promise<void>
}

export interface ModelConfig {
  readonly audio?: {
    readonly sample_rate?: number
  }
  readonly espeak?: {
    readonly voice?: string
  }
  readonly inference?: {
    readonly noise_scale?: number
    readonly length_scale?: number
    readonly noise_w?: number
    readonly phoneme_silence?: Record<string, number>
  }
  readonly phoneme_type?: string
  readonly phoneme_map?: Record<string, readonly string[]>
  readonly phoneme_id_map?: Record<string, readonly number[]>
}

export interface SpeakOptions {
  readonly speakerId?: number,
  readonly utterance: string,
  readonly pitch?: number,
  readonly rate?: number,
  readonly volume?: number
}

export interface PcmData {
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly numChannels: number
}
