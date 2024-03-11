
const PIPER_VER = "1.0.0"

export default {
  piperVer: PIPER_VER,
  serviceUrl: "https://service.lsdsoftware.com",
  repoUrl: `https://huggingface.co/rhasspy/piper-voices/resolve/v${PIPER_VER}/`,

  excludeVoices: new Set([
    "vi_VN-vivos-x_low",
    "vi_VN-25hours_single-low",
  ]),

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

  minPhonemesToPrefetch: 100,
  paragraphSilenceSeconds: .65,
}
