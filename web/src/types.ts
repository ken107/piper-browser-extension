
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

export type InstallState = "not-installed"|"preparing"|number|"installed"

export interface Synthesizer {
  readonly isBusy: boolean
  speak(text: string): Promise<{endPromise: Promise<void>}>
}

export interface ModelConfig {
  readonly what: number
}

export interface MyRequest {
  readonly method: string
  readonly [prop: string]: unknown
}
