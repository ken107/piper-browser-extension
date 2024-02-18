import * as React from "react"
import * as ReactDOM from "react-dom/client"
import config from "./config"
import { getFile } from "./storage"
import { MyVoice, PiperVoice } from "./types"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [voiceList, setVoiceList] = React.useState<MyVoice[]>([])

  //startup
  React.useEffect(() => {
    getVoiceList()
      .then(setVoiceList)
      .catch(handleError)
  }, [])

  //advertise
  React.useEffect(() => {
    (chrome.ttsEngine as any).updateVoices(
      voiceList
        .map(voice => ({
          voiceName: voice.name,
          lang: voice.languageCode,
          eventTypes: ["start", "end", "error"]
        }))
        .sort((a, b) => a.lang.localeCompare(b.lang) || a.voiceName.localeCompare(b.voiceName))
    )
  }, [voiceList])


  const installed = voiceList.filter(x => x.isInstalled)
  const notInstalled = voiceList.filter(x => !x.isInstalled)

  return (
    <div className="container">
      <h2 className="text-muted">Activity Log</h2>
      <textarea className="form-control" disabled rows={5}></textarea>

      {installed.length > 0 &&
        <React.Fragment>
          <h4 className="text-muted">Installed Voices</h4>
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
        </React.Fragment>
      }

      {notInstalled.length > 0 &&
        <React.Fragment>
          <h2 className="text-muted">Available to Install</h2>
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
        </React.Fragment>
      }
    </div>
  )
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

async function piperFetch(file: string): Promise<Blob> {
  const res = await fetch(config.repoUrl + file)
  if (!res.ok) throw new Error("Server return " + res.status)
  return res.blob()
}

function handleError(err: unknown) {
  console.error(err)
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
