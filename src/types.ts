
export interface PiperVoice {
  key: string
  name: string
  language: {
    code: string
    family: string
    region: string
    name_native: string
    name_english: string
    country_english: string
  }
  quality: string
  num_speakers: number
  speaker_id_map: Record<string, number>
  files: Record<string, {
    size_bytes: number
    md5_digest: string
  }>
  aliases: string[]
}

export interface MyVoice {
  key: string
  name: string
  languageCode: string
  languageName: string
  quality: string
  modelFile: string
  modelFileSize: number
  isInstalled: boolean
}
