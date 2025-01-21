import { Message, makeDispatcher } from "@lsdsoftware/message-dispatcher"
import config from "./config"
import { getVoiceList } from "./synthesizer"
import { AdvertisedVoice } from "./types"
import { immediate } from "./utils"


export function advertiseVoices(voices: readonly AdvertisedVoice[]) {
  parent?.postMessage(<Message>{
    type: "notification",
    to: "tts-host",
    method: "advertiseVoices",
    args: {voices}
  }, "*")
}


export async function makeAdvertisedVoiceList(): Promise<AdvertisedVoice[]> {
  const voiceList = await getVoiceList()
  return voiceList
    .map(({id, name, language, gender}) => ({
      voiceName: `Kokoro ${id} (${config.langNameMap[language] || language})`,
      lang: language,
      eventTypes: ["start", "sentence", "end", "error"]
    }))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
}


export function parseAdvertisedVoiceName(name: string): {voiceId: string} {
  const [_, voiceId] = name.split(" ")
  return {
    voiceId
  }
}


export const messageDispatcher = immediate(() => {
  const dispatcher = makeDispatcher<{send(msg: unknown): void}>("tts-service", {})
  addEventListener("message", event => {
    const send = (msg: unknown) => event.source!.postMessage(msg, {targetOrigin: event.origin})
    dispatcher.dispatch(event.data, {send}, send)
  })
  return dispatcher
})
