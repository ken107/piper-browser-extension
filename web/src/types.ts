
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

export interface MyVoice {
  readonly key: string
  readonly name: string
  readonly languageCode: string
  readonly languageName: string
  readonly quality: string
  readonly modelFile: string
  readonly modelFileSize: number
  readonly installState: InstallState
}

export type InstallState = "not-installed"|"installing"|"installed"

export interface Synthesizer {
  readonly isBusy: boolean
  speak(opts: SpeakOptions): Promise<Speech>
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
  phoneme_type?: "espeak"|"text"
  phoneme_map?: Record<string, string[]>
  phoneme_id_map?: Record<string, number[]>
}

export interface SpeakOptions {
  utterance: string,
  pitch?: number,
  rate?: number,
  volume?: number
}

export interface Speech {
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  wait(): Promise<void>
}
