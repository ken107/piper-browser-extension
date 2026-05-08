import { AVAILABLE_LANGS } from "./langs"
import { MyVoice } from "./types"

const appVer = '19'
const ortVer = '1.23.2'
const supertonicVer = '3'

const styleIds = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'] as const

const voiceList: MyVoice[] = styleIds.flatMap(styleId =>
  AVAILABLE_LANGS.map<MyVoice>(lang => ({ id: `${styleId}-${lang}`, styleId, lang }))
)

export default {
  appVer,
  appCacheKey: `app-${appVer}`,

  ortCacheKey: `ort-${ortVer}`,
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/`,

  supertonicCacheKey: `supertonic-${supertonicVer}`,
  supertonicRepoPath: `https://huggingface.co/Supertone/supertonic-${supertonicVer}/resolve/main`,

  installables: [
    'onnx/duration_predictor.onnx',
    'onnx/text_encoder.onnx',
    'onnx/vector_estimator.onnx',
    'onnx/vocoder.onnx'
  ],
  voiceList,
  extensionUrl: 'chrome-extension://mdoplmghlkjcnegkdhocjbjcncocbdhk',

  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,
  sentenceSilenceSeconds: .3,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
