
const PIPER_VER = "1.0.0"

export default {
  piperVer: PIPER_VER,
  serviceUrl: "https://service.lsdsoftware.com",
  repoUrl: `https://huggingface.co/rhasspy/piper-voices/resolve/v${PIPER_VER}/`,
  excludeVoices: new Set([
    "vi_VN-vivos-x_low",
    "vi_VN-25hours_single-low",
  ]),
}
