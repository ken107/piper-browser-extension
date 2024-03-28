import { ModelConfig } from "./types"
import config from "./config"

export interface Phrase {
  readonly phonemes: string[]
  readonly phonemeIds: number[]
  readonly silenceSeconds: number
}


export function makePhonemizer(modelConfig: ModelConfig) {
  const phonemeType = (modelConfig.phoneme_type ?? config.defaults.phonemeType) == "text" ? "text" : "espeak"
  const sentenceSilenceSeconds = config.defaults.sentenceSilenceSeconds

  if (phonemeType == "espeak" && !modelConfig.espeak?.voice) throw new Error("Missing modelConfig.espeak.voice")

  return {
    async batchPhonemize(texts: Array<string>): Promise<Array<Phrase[]>> {
      const res = await fetch(config.serviceUrl + "/piper?capabilities=batchPhonemize-1.0", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          method: "batchPhonemize",
          type: phonemeType,
          texts,
          lang: phonemeType == "espeak" ? modelConfig.espeak!.voice : "ignore"
        })
      })
      if (!res.ok) throw new Error("Server return " + res.status)

      const results = await res.json() as Array<{text: string, phonemes: string[][]}>
      if (results.length != texts.length || results.some((x,i) => x.text != texts[i])) throw new Error("Unexpected")

      return results.map(result => {
        const sentences = result.phonemes
          .map(phonemes => ({
            phonemes,
            silenceSeconds: sentenceSilenceSeconds
          }))

        //TODO: handle phoneme_silence, i.e. break sentences further into phrases to insert phoneme silence
        const phrases = sentences

        return phrases
          .filter(x => x.phonemes.length)
          .map(({phonemes, silenceSeconds}) => ({
            phonemes,
            phonemeIds: toPhonemeIds(phonemes, modelConfig),
            silenceSeconds
          }))
      })
    }
  }
}


//from: piper-phonemize/src/phoneme_ids.cpp
function toPhonemeIds(phonemes: readonly string[], modelConfig: ModelConfig): number[] {
  if (!modelConfig.phoneme_id_map) throw new Error("Missing modelConfig.phoneme_id_map")

  const {bos, eos, pad, addBos, addEos, interspersePad} = config.phonemeIdConfig
  const missing = new Set<string>()
  const phonemeIds = [] as number[]

  if (addBos) {
    phonemeIds.push(...modelConfig.phoneme_id_map[bos])
    if (interspersePad)
      phonemeIds.push(...modelConfig.phoneme_id_map[pad])
  }

  for (const phoneme of phonemes) {
    if (phoneme in modelConfig.phoneme_id_map) {
      phonemeIds.push(...modelConfig.phoneme_id_map[phoneme])
      if (interspersePad)
        phonemeIds.push(...modelConfig.phoneme_id_map[pad])
    }
    else {
      missing.add(phoneme)
    }
  }

  if (addEos) {
    phonemeIds.push(...modelConfig.phoneme_id_map[eos])
  }

  if (missing.size) console.warn("Missing mapping for phonemes", missing)
  return phonemeIds
}
