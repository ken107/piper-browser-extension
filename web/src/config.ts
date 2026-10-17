import { MyVoice } from "./types"

const appVer = '1'
const ortVer = '1.23.2'
const pocketVer = '0'

//built-in English voices in voices.bin
const voiceList: MyVoice[] = [
  { id: 'alba', lang: 'en-US' },
  { id: 'anna', lang: 'en-US' },
  { id: 'azelma', lang: 'en-US' },
  { id: 'bill_boerst', lang: 'en-US' },
  { id: 'caro_davy', lang: 'en-US' },
  { id: 'charles', lang: 'en-US' },
  { id: 'cosette', lang: 'en-US' },
  { id: 'eponine', lang: 'en-US' },
  { id: 'eve', lang: 'en-US' },
  { id: 'fantine', lang: 'en-US' },
  { id: 'george', lang: 'en-US' },
  { id: 'jane', lang: 'en-US' },
  { id: 'jean', lang: 'en-US' },
  { id: 'javert', lang: 'en-US' },
  { id: 'marius', lang: 'en-US' },
  { id: 'mary', lang: 'en-US' },
  { id: 'michael', lang: 'en-US' },
  { id: 'paul', lang: 'en-US' },
  { id: 'peter_yearsley', lang: 'en-US' },
  { id: 'stuart_bell', lang: 'en-US' },
  { id: 'vera', lang: 'en-US' },
]

export default {
  appVer,
  appCacheKey: `app-${appVer}`,

  ortCacheKey: `ort-${ortVer}`,
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/`,

  pocketCacheKey: `pocket-${pocketVer}`,
  //INT8 ONNX export by KevinAHM; consider mirroring to a model repo we control
  pocketRepoPath: 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main/onnx/english_2026-04',

  installables: [
    'bundle.json',
    'tokenizer.model',
    'text_conditioner_int8.onnx',
    'flow_lm_main_int8.onnx',
    'flow_lm_flow_int8.onnx',
    'mimi_decoder_int8.onnx',
    'voices.bin',
  ],
  voiceList,
  //TODO: placeholder, set to the PocketTTS extension's ID once it is published
  extensionUrl: 'chrome-extension://mdoplmghlkjcnegkdhocjbjcncocbdhk',

  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,
  sentenceSilenceSeconds: .3,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
