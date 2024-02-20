import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { advertiseVoices, createSynthesizer, deleteVoice, getInstalledVoice, getVoiceList, installVoice, requestListener, sampler, speechManager } from "./services"
import { MyRequest, MyVoice, Synthesizer } from "./types"
import { immediate } from "./utils"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [state, stateUpdater] = useImmer({
    voiceList: [] as MyVoice[],
    activityLog: "Ready",
    synthesizers: {} as Record<string, Synthesizer|undefined>
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
    if (state.voiceList.length) advertiseVoices(installed.length ? installed : notInstalled)
  }, [
    state.voiceList
  ])

  //handle requests
  React.useEffect(() => {
    requestListener.setHandlers({
      speak: onSpeak,
      wait: onWait,
      pause: onPause,
      resume: onResume,
      stop: onStop,
    })
  })

  //auto-scroll activity log
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
                  <InstallButton voice={voice} onInstall={onInstall} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      }
    </div>
  )


  //controllers

  function handleError(err: unknown) {
    console.error(err)
    appendActivityLog(String(err))
  }

  function appendActivityLog(text: string) {
    stateUpdater(draft => {
      draft.activityLog += "\n" + text
    })
  }

  async function onInstall(voice: MyVoice, onProgress: (percent: number) => void) {
    try {
      stateUpdater(draft => {
        draft.voiceList.find(x => x.key == voice.key)!.installState = "installing"
      })
      const {model, modelConfig} = await installVoice(voice, onProgress)
      const synth = createSynthesizer(model, modelConfig)
      stateUpdater(draft => {
        draft.voiceList.find(x => x.key == voice.key)!.installState = "installed"
        draft.synthesizers[voice.key] = synth
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
  
  function getStatusText(voice: MyVoice) {
    const synth = state.synthesizers[voice.key]
    if (synth) {
      if (synth.isBusy) return "in use"
      else return "in memory"
    }
    else {
      return "on disk"
    }
  }

  async function onSpeak({utterance, voiceName, pitch, rate, volume}: MyRequest) {
    if (!(
      typeof utterance == "string" &&
      typeof voiceName == "string" &&
      (typeof pitch == "number" || typeof pitch == "undefined") &&
      (typeof rate == "number" || typeof rate == "undefined") &&
      (typeof volume == "number" || typeof volume == "undefined")
    )) {
      throw new Error("Bad args")
    }
    const voiceKey = voiceName.split(" ")[1]
    let synth = state.synthesizers[voiceKey]
    if (!synth) {
      const {model, modelConfig} = await getInstalledVoice(voiceKey)
      synth = createSynthesizer(model, modelConfig)
      stateUpdater(draft => {
        draft.synthesizers[voiceKey] = synth
      })
    }
    stateUpdater(draft => {
      const draftSynth = draft.synthesizers[voiceKey]
      if (draftSynth) draftSynth.isBusy = true
    })
    try {
      const speech = await synth.speak({utterance, pitch, rate, volume})
      return {
        speechId: speechManager.add(speech)
      }
    }
    finally {
      stateUpdater(draft => {
        const draftSynth = draft.synthesizers[voiceKey]
        if (draftSynth) draftSynth.isBusy = false
      })
    }
  }

  async function onWait({speechId}: MyRequest) {
    if (typeof speechId != "string") throw new Error("Bad args")
    await speechManager.get(speechId)?.wait()
  }

  async function onPause({speechId}: MyRequest) {
    if (typeof speechId != "string") throw new Error("Bad args")
    await speechManager.get(speechId)?.pause()
  }

  async function onResume({speechId}: MyRequest) {
    if (typeof speechId != "string") throw new Error("Bad args")
    await speechManager.get(speechId)?.resume()
  }

  async function onStop({speechId}: MyRequest) {
    if (typeof speechId != "string") throw new Error("Bad args")
    await speechManager.get(speechId)?.stop()
  }
}



function InstallButton({voice, onInstall}: {
  voice: MyVoice
  onInstall(voice: MyVoice, onProgress: (percent: number) => void): void
}) {
  const [percent, setPercent] = React.useState<number>(0)

  React.useEffect(() => {
    if (voice.installState == "not-installed") setPercent(0)
  }, [voice.installState])

  const text = immediate(() => {
    switch (voice.installState) {
      case "not-installed": return "Install"
      case "installing": return Math.round(percent) + "%"
      case "installed": return "100%"
    }
  })

  return (
    <button type="button" className="btn btn-success btn-sm"
      disabled={voice.installState != "not-installed"}
      onClick={() => onInstall(voice, setPercent)}>{text}</button>
  )
}
