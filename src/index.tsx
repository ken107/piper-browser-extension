import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import config from "./config"
import { getFile } from "./storage"
import { MyVoice, PiperVoice } from "./types"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [state, stateUpdater] = useImmer({
    voiceList: [] as MyVoice[],
    activityLog: "Ready",
  })
  const refs = {
    activityLog: React.useRef<HTMLTextAreaElement>(null!)
  }
  const installed = state.voiceList.filter(x => x.isInstalled)
  const notInstalled = state.voiceList.filter(x => !x.isInstalled)


  //startup
  React.useEffect(() => {
    getVoiceList()
      .then(voiceList => stateUpdater(draft => {
        draft.voiceList = voiceList
      }))
      .catch(handleError)
  }, [
  ])

  //advertise voices
  React.useEffect(() => {
    advertiseVoices(installed.length ? installed : notInstalled)
  }, [
    state.voiceList
  ])

  //scroll activity log
  React.useEffect(() => {
    refs.activityLog.current.scrollTop = refs.activityLog.current.scrollHeight
  }, [
    state.activityLog
  ])


  return (
    <div className="container">
      <h2 className="text-muted">Activity Log</h2>
      <textarea className="form-control" disabled rows={4} ref={refs.activityLog} value={state.activityLog} />

      <h2 className="text-muted">Installed Voices ({installed.length})</h2>
      {installed.length == 0 &&
        <div className="text-muted">Installed voices will appear here</div>
      }
      {installed.length > 0 &&
        <table className="table table-borderless table-hover table-sm">
          <thead>
            <tr>
              <th>Voice</th>
              <th>Language</th>
              <th></th>
              <th style={{width: "0%"}}></th>
            </tr>
          </thead>
          <tbody>
            {installed.map(voice =>
              <tr key={voice.key}>
                <td>
                  <span className="me-1">{voice.name}</span>
                  <span className="me-1">[{voice.quality}]</span>
                  <span className="link" onClick={() => sampler.play(voice)}>sample</span>
                </td>
                <td>{voice.languageName}</td>
                <td className="text-end pe-2">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                <td>
                  <button type="button" className="btn btn-danger btn-sm">Delete</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      }

      <h2 className="text-muted">Available to Install ({notInstalled.length})</h2>
      {notInstalled.length > 0 &&
        <table className="table table-borderless table-hover table-sm">
          <thead>
            <tr>
              <th>Voice</th>
              <th>Language</th>
              <th></th>
              <th style={{width: "0%"}}></th>
            </tr>
          </thead>
          <tbody>
            {notInstalled.map(voice =>
              <tr key={voice.key}>
                <td>
                  <span className="me-1">{voice.name}</span>
                  <span className="me-1">[{voice.quality}]</span>
                  <span className="link" onClick={() => sampler.play(voice)}>sample</span>
                </td>
                <td>{voice.languageName}</td>
                <td className="text-end pe-2">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                <td>
                  <button type="button" className="btn btn-success btn-sm">Install</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      }
    </div>
  )

  function handleError(err: unknown) {
    console.error(err)
    appendActivityLog(String(err))
  }

  function appendActivityLog(text: string) {
    stateUpdater(draft => {
      draft.activityLog += "\n" + text
    })
  }
}



async function getVoiceList(): Promise<MyVoice[]> {
  const blob = await getFile("voices.json", () => piperFetch("voices.json"))
  const voicesJson: Record<string, PiperVoice> = await blob.text().then(JSON.parse)
  const voiceList = Object.values(voicesJson)
    .map<MyVoice>(voice => {
      const modelFile = Object.keys(voice.files).find(x => x.endsWith(".onnx"))
      if (!modelFile) throw new Error("Can't identify model file for " + voice.name)
      return {
        key: voice.key,
        name: voice.name,
        languageCode: voice.language.family.toLowerCase() + "-" + voice.language.region.toUpperCase(),
        languageName: voice.language.name_native + " [" + voice.language.country_english + "]",
        quality: voice.quality,
        modelFile,
        modelFileSize: voice.files[modelFile].size_bytes,
        isInstalled: false
      }
    })
  for (const voice of voiceList) {
    voice.isInstalled = await getFile(voice.modelFile).then(() => true).catch(err => false)
  }
  return voiceList
}

function advertiseVoices(voices: MyVoice[]) {
  (chrome.ttsEngine as any).updateVoices(
    voices
      .map(voice => ({
        voiceName: voice.name,
        lang: voice.languageCode,
        eventTypes: ["start", "end", "error"]
      }))
      .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
  )
}

async function piperFetch(file: string): Promise<Blob> {
  const res = await fetch(config.repoUrl + file)
  if (!res.ok) throw new Error("Server return " + res.status)
  return res.blob()
}

function immediate<T>(func: () => T) {
  return func()
}

const sampler = immediate(() => {
  const audio = new Audio()
  audio.autoplay = true
  return {
    play(voice: MyVoice) {
      const tokens = voice.modelFile.split("/")
      tokens.pop()
      audio.src = config.repoUrl + tokens.join("/") + "/samples/speaker_0.mp3"
    }
  }
})
