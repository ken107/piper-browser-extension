
const PIPER_VER = "1.0.0"

export default {
  piperVer: PIPER_VER,
  serviceUrl: "https://service.lsdsoftware.com",
  repoUrl: `https://huggingface.co/rhasspy/piper-voices/resolve/v${PIPER_VER}/`,

  voiceList: {
    file: "voices.json",
    maxAge: 7*24*3600*1000
  },
  excludeVoices: new Set([
    "vi_VN-vivos-x_low",
    "vi_VN-25hours_single-low",
  ]),

  stats: {
    file: "stats.json",
    maxAge: 3600*1000
  },

  //from: piper/src/cpp/piper.hpp
  defaults: {
    phonemeType: "espeak",
    sampleRate: 22050,
    numChannels: 1,
    noiseScale: 0.667,
    lengthScale: 1,
    noiseW: 0.8,
    sentenceSilenceSeconds: .2,
  },

  //from: piper-phonemize/src/phoneme_ids.hpp
  phonemeIdConfig: {
    pad: '_',
    bos: '^',
    eos: '$',

    // Every other phoneme id is pad
    interspersePad: true,

    // Add beginning of sentence (bos) symbol at start
    addBos: true,

    // Add end of sentence (eos) symbol at end
    addEos: true,
  },

  phonemizeBatchSize: 1000,
  numPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .75,

  testSpeech: "It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy...",
}
