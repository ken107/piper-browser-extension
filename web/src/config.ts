const appVer = '1'
const ortVer = '1.23.2'
const pocketVer = '1'

export default {
  appVer,
  appCacheKey: `app-${appVer}`,

  ortCacheKey: `ort-${ortVer}`,
  ortWasmPaths: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/`,

  pocketCacheKey: `pocket-${pocketVer}`,
  //INT8 ONNX export made with export/, pinned to a commit so cached files stay consistent
  pocketModel: 'english_18m_2026-10',
  pocketRepoPath: 'https://huggingface.co/ken107/pocket-tts-onnx/resolve/1051c1f9d3177e8050411dd3e173547b88058a35/english_18m_2026-10',
  //reference clips the voices are cloned from, cached with the model files
  voicesRepoPath: 'https://huggingface.co/kyutai/tts-voices/resolve/main',
  voicesApiPath: 'https://huggingface.co/api/models/kyutai/tts-voices',

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
  //set to the PocketTTS extension's URL (chrome-extension://<id>) once it is published
  extensionUrl: null as string|null,
  extensionStoreUrl: null as string|null,

  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,
  sentenceSilenceSeconds: .3,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
