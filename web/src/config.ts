import { MyVoice } from "./types"

const ortVer = '1.23.2'
const supertonicVer = '0'
const supertonicRepoPath = `https://huggingface.co/Supertone/supertonic/resolve/main`
const onnxDir = `${supertonicRepoPath}/onnx`

const voiceList: MyVoice[] = [
  { id: 'M1', lang: 'en-US' },
  { id: 'M2', lang: 'en-US' },
  { id: 'F1', lang: 'en-US' },
  { id: 'F2', lang: 'en-US' },
].map(voice => ({
  ...voice,
  stylePath: `${supertonicRepoPath}/voice_styles/${voice.id}.json`
}))

export default {
  ortCacheKey: `ort-${ortVer}`,
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/`,

  supertonicCacheKey: `supertonic-${supertonicVer}`,
  supertonicRepoPath,

  installables: [
    ...voiceList.map(voice => voice.stylePath),
    ...[
      'tts.json',
      'unicode_indexer.json',
      'duration_predictor.onnx',
      'text_encoder.onnx',
      'vector_estimator.onnx',
      'vocoder.onnx'
    ].map(file => `${onnxDir}/${file}`)
  ],
  onnxDir,
  voiceList,

  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,
  sentenceSilenceSeconds: .3,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
