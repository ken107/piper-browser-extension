import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { advertiseVoices, createSynthesizer, deleteVoice, getVoiceList, installVoice, jobManager, requestListener, sampler } from "./services"
import { MyRequest, MyVoice, Synthesizer } from "./types"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [state, stateUpdater] = useImmer({
    voiceList: [] as MyVoice[],
    activityLog: "Ready",
    synthesizers: new Map<string, Synthesizer>()
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

  //handle requests
  React.useEffect(() => {
    requestListener.setHandlers({
      onSynthesize,
    })
  }, [
    state.synthesizers,
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
              <th>Status</th>
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
                <td>({getStatusText(voice)})</td>
                <td className="text-end">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                <td className="text-end ps-2">
                  <button type="button" className="btn btn-danger btn-sm"
                    onClick={() => onDelete(voice)}>Delete</button>
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
                <td className="text-end">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                <td className="text-end ps-2">
                  <button type="button" className="btn btn-success btn-sm"
                    disabled={voice.installState != "not-installed"}
                    onClick={() => onInstall(voice)}>{getInstallButtonText(voice)}</button>
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

  async function onInstall(voice: MyVoice) {
    try {
      stateUpdater(draft => {
        draft.voiceList.find(x => x.key == voice.key)!.installState = "preparing"
      })
      const {model, modelConfig} = await installVoice(voice, percent => {
        stateUpdater(draft => {
          draft.voiceList.find(x => x.key == voice.key)!.installState = percent
        })
      })
      stateUpdater(draft => {
        draft.voiceList.find(x => x.key == voice.key)!.installState = "installed"
        draft.synthesizers.set(voice.key, createSynthesizer(model, modelConfig))
      })
    }
    catch (err) {
      handleError(err)
    }
  }

  async function onDelete(voice: MyVoice) {
    try {
      await deleteVoice(voice)
      stateUpdater(draft => {
        draft.voiceList.find(x => x.key == voice.key)!.installState = "not-installed"
      })
    }
    catch (err) {
      handleError(err)
    }
  }

  function getInstallButtonText(voice: MyVoice) {
    switch (voice.installState) {
      case "not-installed": return "Install"
      case "installed": return "100%"
      case "preparing": return "Preparing"
      default: return Math.round(voice.installState) + "%"
    }
  }
  
  function getStatusText(voice: MyVoice) {
    const synth = state.synthesizers.get(voice.key)
    if (synth) {
      if (synth.isBusy) return "in use"
      else return "in memory"
    }
    else {
      return "on disk"
    }
  }

  //dependencies: state.synthesizers
  async function onSynthesize({text, voice}: MyRequest) {
    if (typeof text != "string" || typeof voice != "string") throw new Error("Bad args")
    const voiceKey = voice.split(" ")[1]
    const synth = state.synthesizers.get(voiceKey)
    if (synth) {
      stateUpdater(draft => {
        const draftSynth = draft.synthesizers.get(voiceKey)
        if (draftSynth) draftSynth.isBusy = true
      })
      try {
        const {endPromise} = await synth.speak(text)
        const jobId = jobManager.add(endPromise)
        return jobId
      }
      finally {
        stateUpdater(draft => {
          const draftSynth = draft.synthesizers.get(voiceKey)
          if (draftSynth) draftSynth.isBusy = false
        })
      }
    }
    else {
      //play audio "Voice is not currently installed"
      //call parent.requestFocus()
    }
  }
}
