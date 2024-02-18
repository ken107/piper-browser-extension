import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { advertiseVoices, createSynthesizer, getVoiceList, piperFetch, sampler } from "./services"
import { getFile } from "./storage"
import { InstallState, ModelConfig, MyVoice, Synthesizer } from "./types"
import { fetchWithProgress } from "./utils"
import config from "./config"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [state, stateUpdater] = useImmer({
    voiceList: [] as MyVoice[],
    activityLog: "Ready",
    synthesizers: {} as Record<string, Synthesizer>
  })
  const refs = {
    activityLog: React.useRef<HTMLTextAreaElement>(null!)
  }
  const installed = state.voiceList.filter(x => x.installState == "installed")
  const notInstalled = state.voiceList.filter(x => x.installState != "installed")


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
                  <button type="button" className="btn btn-success btn-sm"
                    disabled={voice.installState != "not-installed"}
                    onClick={() => installVoice(voice)}>{getInstallButtonText(voice.installState)}</button>
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

  function installVoice(voice: MyVoice) {
    getFile(voice.modelFile, () => fetchWithProgress(voice.modelFile, percent => {
        stateUpdater(draft => {
          const voiceDraft = draft.voiceList.find(x => x.key == voice.key)
          if (voiceDraft) voiceDraft.installState = percent
        })
      }))
      .then(async model => {
        if (!state.synthesizers[voice.key]) {
          const modelConfig = await piperFetch(voice.modelFile + ".json").then(x => x.text()).then(JSON.parse)
          stateUpdater(draft => {
            draft.synthesizers[voice.key] = createSynthesizer(model, modelConfig)
          })
        }
      })
      .catch(handleError)
    }

    function getInstallButtonText(installState: InstallState) {
    switch (installState) {
      case "not-installed": return "Install"
      case "installed": return "100%"
      default: return Math.round(installState) + "%"
    }
  }
}
