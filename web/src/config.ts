import { MyVoice } from "./types"

const appVer = '1'
const ortVer = '1.23.2'
const pocketVer = '0'

//Kyutai's catalog voices (pocket-tts README), limited to clips licensed for commercial use;
//each voice is cloned in-browser from its reference clip in the kyutai/tts-voices repo
const voiceList: MyVoice[] = [
  { id: 'alba', lang: 'en-US', clip: 'alba-mackenna/casual.wav', license: 'CC BY 4.0' },
  { id: 'anna', lang: 'en-US', clip: 'vctk/p228_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'azelma', lang: 'en-US', clip: 'vctk/p303_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'bill_boerst', lang: 'en-US', clip: 'voice-zero/bill_boerst.wav', license: 'CC0' },
  { id: 'caro_davy', lang: 'en-US', clip: 'voice-zero/caro_davy.wav', license: 'CC0' },
  { id: 'charles', lang: 'en-US', clip: 'vctk/p254_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'eponine', lang: 'en-US', clip: 'vctk/p262_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'eve', lang: 'en-US', clip: 'vctk/p361_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'fantine', lang: 'en-US', clip: 'vctk/p244_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'george', lang: 'en-US', clip: 'vctk/p315_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'jane', lang: 'en-US', clip: 'vctk/p339_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'javert', lang: 'en-US', clip: 'voice-donations/Butter.wav', license: 'CC0' },
  { id: 'marius', lang: 'en-US', clip: 'voice-donations/Selfie.wav', license: 'CC0' },
  { id: 'mary', lang: 'en-US', clip: 'vctk/p333_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'michael', lang: 'en-US', clip: 'vctk/p360_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'paul', lang: 'en-US', clip: 'vctk/p259_023_enhanced.wav', license: 'CC BY 4.0' },
  { id: 'peter_yearsley', lang: 'en-US', clip: 'voice-zero/peter_yearsley.wav', license: 'CC0' },
  { id: 'stuart_bell', lang: 'en-US', clip: 'voice-zero/stuart_bell.wav', license: 'CC0' },
  { id: 'vera', lang: 'en-US', clip: 'vctk/p229_023_enhanced.wav', license: 'CC BY 4.0' },
]

export default {
  appVer,
  appCacheKey: `app-${appVer}`,

  ortCacheKey: `ort-${ortVer}`,
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/`,

  pocketCacheKey: `pocket-${pocketVer}`,
  //INT8 ONNX export by KevinAHM; consider mirroring to a model repo we control
  pocketRepoPath: 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/main/onnx/english_2026-04',
  //reference clips the voices are cloned from, cached with the model files
  voicesRepoPath: 'https://huggingface.co/kyutai/tts-voices/resolve/main',

  installables: [
    'bundle.json',
    'tokenizer.model',
    'text_conditioner_int8.onnx',
    'flow_lm_main_int8.onnx',
    'flow_lm_flow_int8.onnx',
    'mimi_decoder_int8.onnx',
    'mimi_encoder_int8.onnx',
    'bos_before_voice.npy',
  ],
  voiceList,
  //set to the PocketTTS extension's URL (chrome-extension://<id>) once it is published
  extensionUrl: null as string|null,
  extensionStoreUrl: null as string|null,

  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,
  sentenceSilenceSeconds: .3,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
