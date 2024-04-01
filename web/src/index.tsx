import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { advertiseVoices, deleteVoice, getPopularity, getVoiceList, installVoice, makeAdvertisedVoiceList, messageDispatcher, parseAdvertisedVoiceName, sampler, updateStats } from "./services"
import { makeSpeech } from "./speech"
import * as storage from "./storage"
import { makeSynthesizer } from "./synthesizer"
import { MyVoice } from "./types"
import { immediate } from "./utils"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)

const synthesizers = new Map<string, ReturnType<typeof makeSynthesizer>>()
let currentSpeech: ReturnType<typeof makeSpeech>|undefined


function App() {
  const [state, stateUpdater] = useImmer({
    voiceList: null as MyVoice[]|null,
    popularity: {} as {[voiceKey: string]: number},
    activityLog: "",
    isExpanded: {} as Record<string, boolean>,
    showInfoBox: false,
  })
  const refs = {
    activityLog: React.useRef<HTMLTextAreaElement>(null!),
  }
  const installed = React.useMemo(() => state.voiceList?.filter(x => x.installState == "installed") ?? [], [state.voiceList])
  const notInstalled = React.useMemo(() => state.voiceList?.filter(x => x.installState != "installed") ?? [], [state.voiceList])
  const advertised = React.useMemo(() => makeAdvertisedVoiceList(state.voiceList), [state.voiceList])


  //startup
  React.useEffect(() => {
    getVoiceList()
      .then(voiceList => stateUpdater(draft => {
        draft.voiceList = voiceList
      }))
      .catch(reportError)
    getPopularity()
      .then(popularity => stateUpdater(draft => {
        draft.popularity = popularity
      }))
      .catch(console.error)
  }, [])

  //advertise voices
  React.useEffect(() => {
    if (advertised) advertiseVoices(advertised)
  }, [
    advertised
  ])

  //handle requests
  React.useEffect(() => {
    messageDispatcher.updateHandlers({
      speak: onSpeak,
      pause: onPause,
      resume: onResume,
      stop: onStop,
      forward: onForward,
      rewind: onRewind,
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
      <div className="text-end text-muted small mt-1 mb-4">
        <span className="link"
          onClick={() => stateUpdater(draft => {draft.showInfoBox = true})}>What is Piper?</span>
      </div>

      {top == self &&
        <div>
          <h2 className="text-muted">Test</h2>
          <form onSubmit={onSubmitTest}>
            <textarea className="form-control" rows={3} name="text" defaultValue="It is a period of civil war. Rebel spaceships, striking from a hidden base, have won their first victory against the evil Galactic Empire. During the battle, Rebel spies managed to steal secret plans to the Empire's ultimate weapon, the DEATH STAR, an armored space station with enough power to destroy an entire planet. Pursued by the Empire's sinister agents, Princess Leia races home aboard her starship, custodian of the stolen plans that can save her people and restore freedom to the galaxy..." />
            <select className="form-control mt-3" name="voice">
              <option value="">Select a voice</option>
              {advertised?.map(voice =>
                <option key={voice.voiceName} value={voice.voiceName}>{voice.voiceName}</option>
              )}
            </select>
            <button type="submit" className="btn btn-primary mt-3">Speak</button>
            {location.hostname == "localhost" &&
              <>
                <button type="button" className="btn btn-secondary mt-3 ms-1"
                  onClick={() => onPause()}>Pause</button>
                <button type="button" className="btn btn-secondary mt-3 ms-1"
                  onClick={() => onResume()}>Resume</button>
                <button type="button" className="btn btn-secondary mt-3 ms-1"
                  onClick={() => onStop()}>Stop</button>
                <button type="button" className="btn btn-secondary mt-3 ms-1"
                  onClick={() => onForward()}>Forward</button>
                <button type="button" className="btn btn-secondary mt-3 ms-1"
                  onClick={() => onRewind()}>Rewind</button>
              </>
            }
          </form>
        </div>
      }

      <div>
        <h2 className="text-muted">Activity Log</h2>
        <textarea className="form-control" disabled rows={4} ref={refs.activityLog} value={state.activityLog} />
      </div>

      <div>
        <h2 className="text-muted">Installed</h2>
        {installed.length == 0 &&
          <div className="text-muted">Installed voices will appear here</div>
        }
        {installed.length > 0 &&
          <table className="table table-borderless table-hover table-sm">
            <thead>
              <tr>
                <th>Voice Pack</th>
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
                    {voice.num_speakers <= 1 &&
                      <span className="link" onClick={() => sampler.play(voice)}>sample</span>
                    }
                    {voice.num_speakers > 1 &&
                      <span style={{cursor: "pointer"}}
                        onClick={() => toggleExpanded(voice.key)}>({voice.num_speakers} voices) {state.isExpanded[voice.key] ? '▲' : '▼'}</span>
                    }
                    {state.isExpanded[voice.key] &&
                      <ul>
                        {Object.entries(voice.speaker_id_map).map(([speakerName, speakerId]) =>
                          <li key={speakerId}>
                            <span className="me-1">{speakerName}</span>
                            <span className="link" onClick={() => sampler.play(voice, speakerId)}>sample</span>
                          </li>
                        )}
                      </ul>
                    }
                  </td>
                  <td className="align-top">{voice.language.name_native} ({voice.language.country_english})</td>
                  <td className="align-top">
                    {immediate(() => {
                      if (voice.numActiveUsers) return <span style={{fontWeight: "bold"}}>(in use)</span>
                      switch (voice.loadState) {
                        case "not-loaded": return "(on disk)"
                        case "loading": return <span style={{fontWeight: "bold", color: "red"}}>(loading)</span>
                        case "loaded": return "(in memory)"
                      }
                    })}
                  </td>
                  <td className="align-top text-end">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                  <td className="align-top text-end ps-2">
                    <button type="button" className="btn btn-danger btn-sm"
                      onClick={() => onDelete(voice.key)}>Delete</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        }
      </div>

      <div>
        <h2 className="text-muted">Available to Install</h2>
        {notInstalled.length > 0 &&
          <table className="table table-borderless table-hover table-sm">
            <thead>
              <tr>
                <th>Voice Pack</th>
                <th>Language</th>
                <th>Popularity</th>
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
                    {voice.num_speakers <= 1 &&
                      <span className="link" onClick={() => sampler.play(voice)}>sample</span>
                    }
                    {voice.num_speakers > 1 &&
                      <span style={{cursor: "pointer"}}
                        onClick={() => toggleExpanded(voice.key)}>({voice.num_speakers} voices) {state.isExpanded[voice.key] ? '▲' : '▼'}</span>
                    }
                    {state.isExpanded[voice.key] &&
                      <ul>
                        {voice.speakerList.map(({speakerName, speakerId}) =>
                          <li key={speakerName}>
                            <span className="me-1">{speakerName}</span>
                            <span className="link" onClick={() => sampler.play(voice, speakerId)}>sample</span>
                          </li>
                        )}
                      </ul>
                    }
                  </td>
                  <td className="align-top">{voice.language.name_native} ({voice.language.country_english})</td>
                  <td className="align-top">
                    <div>{state.popularity[voice.key] ?? "\u00A0"}</div>
                    {state.isExpanded[voice.key] &&
                      voice.speakerList.map(({speakerName}) =>
                        <div key={speakerName}>{state.popularity[voice.key + speakerName] ?? "\u00A0"}</div>
                      )
                    }
                  </td>
                  <td className="align-top text-end">{(voice.modelFileSize /1e6).toFixed(1)}MB</td>
                  <td className="align-top text-end ps-2">
                    <InstallButton voice={voice} onInstall={onInstall} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        }
      </div>

      <div className="text-center text-muted small mb-2">
        <span><a target="_blank" href="https://readaloud.app/tos.html" className="muted-link">Terms of Service</a> &mdash; </span>
        <span><a target="_blank" href="https://readaloud.app/privacy.html" className="muted-link">Privacy Policy</a> &mdash; </span>
        <span>&copy; <a target="_blank" href="https://lsdsoftware.com" className="muted-link">LSD Software</a></span>
      </div>

      {state.showInfoBox &&
        <div className="modal d-block" style={{backgroundColor: "rgba(0,0,0,.5)"}} tabIndex={-1} aria-hidden="true"
          onClick={e => e.target == e.currentTarget && stateUpdater(draft => {draft.showInfoBox = false})}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">What is Piper?</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => stateUpdater(draft => {draft.showInfoBox = false})}></button>
              </div>
              <div className="modal-body">
                <p>
                  Piper is a collection of high-quality, open-source text-to-speech voices developed by
                  the <a target="_blank" href="https://github.com/rhasspy/piper">Piper Project</a>,
                  powered by machine learning technology.
                  These voices are synthesized in-browser, requiring no cloud subscriptions, and are entirely
                  free to use.
                  You can use them to read aloud web pages and documents with
                  the <a target="_blank" href="https://readaloud.app">Read Aloud</a> extension,
                  or make them generally available to all browser apps through
                  the <a target="_blank" href="https://ttstool.com/redirect.html?target=piper-tts-extension">Piper TTS</a> extension.
                </p>
                <p>
                  Each of the voice packs is a machine learning model capable of synthesizing one or more
                  distinct voices.  Each pack must be separately installed.
                  Due to the substantial size of these voice packs, it is advisable to install only those
                  that you intend to use.
                  To assist in your selection, you can refer to the "Popularity" ranking, which indicates the
                  preferred choices among users.
                </p>
              </div>
            </div>
          </div>
        </div>
      }
    </div>
  )


  //controllers

  function reportError(err: unknown) {
    if (err instanceof Error) {
      console.error(err)
      appendActivityLog(String(err))
    }
    else {
      appendActivityLog(JSON.stringify(err))
    }
  }

  function appendActivityLog(text: string) {
    stateUpdater(draft => {
      draft.activityLog += text + '\n'
    })
  }

  function toggleExpanded(voiceKey: string) {
    stateUpdater(draft => {
      draft.isExpanded[voiceKey] = !draft.isExpanded[voiceKey]
    })
  }

  async function onInstall(voice: MyVoice, onProgress: (percent: number) => void) {
    storage.requestPersistence()
      .then(granted => console.info("Persistent storage:", granted))
      .catch(console.error)
    try {
      stateUpdater(draft => {
        draft.voiceList!.find(x => x.key == voice.key)!.installState = "installing"
      })
      const {model, modelConfig} = await installVoice(voice, onProgress)
      stateUpdater(draft => {
        draft.voiceList!.find(x => x.key == voice.key)!.installState = "installed"
      })
    }
    catch (err) {
      reportError(err)
    }
  }

  async function onDelete(voiceKey: string) {
    if (!confirm("Are you sure you want to uninstall this voice?")) return;
    try {
      synthesizers.get(voiceKey)?.dispose()
      synthesizers.delete(voiceKey)
      await deleteVoice(voiceKey)
      stateUpdater(draft => {
        const voiceDraft = draft.voiceList!.find(x => x.key == voiceKey)!
        voiceDraft.loadState = "not-loaded"
        voiceDraft.installState = "not-installed"
      })
    }
    catch (err) {
      reportError(err)
    }
  }

  async function onSpeak({utterance, voiceName, pitch, rate, volume}: Record<string, unknown>, sender: {send(message: unknown): void}) {
    if (!(
      typeof utterance == "string" &&
      typeof voiceName == "string" &&
      (typeof pitch == "number" || typeof pitch == "undefined") &&
      (typeof rate == "number" || typeof rate == "undefined") &&
      (typeof volume == "number" || typeof volume == "undefined")
    )) {
      throw new Error("Bad args")
    }

    const {modelId, speakerName} = parseAdvertisedVoiceName(voiceName)
    const voice = state.voiceList!.find(({key}) => key.endsWith('-' + modelId))
    if (!voice) throw new Error("Voice not found")

    const speakerId = immediate(() => {
      if (speakerName) {
        if (!(speakerName in voice.speaker_id_map)) throw new Error("Speaker name not found")
        return voice.speaker_id_map[speakerName]
      }
    })

    appendActivityLog(`Speaking '${utterance.slice(0,50).replace(/\s+/g,' ')}...' using ${voice.name} [${voice.quality}] ${speakerName ?? ''}`)

    const synth = synthesizers.get(voice.key) ?? immediate(() => {
      appendActivityLog(`Initializing ${voice.name} [${voice.quality}], please wait...`)
      const tmp = makeSynthesizer(voice.key)
      synthesizers.set(voice.key, tmp)
      return tmp
    })

    currentSpeech?.cancel()
    const speech = currentSpeech = makeSpeech(synth, {speakerId, text: utterance, pitch, rate, volume}, {
      onSentence(startIndex, endIndex) {
        notifyCaller("onSentence", {startIndex, endIndex})
      }
    })
    function notifyCaller(method: string, args?: Record<string, unknown>) {
      if (speech == currentSpeech)
        sender.send({to: "piper-host", type: "notification", method, args})
    }

    immediate(async () => {
      try {
        try {
          stateUpdater(draft => {
            draft.voiceList!.find(x => x.key == voice.key)!.loadState = "loading"
          })
          await synth.readyPromise
        }
        finally {
          stateUpdater(draft => {
            draft.voiceList!.find(x => x.key == voice.key)!.loadState = "loaded"
          })
        }

        const start = Date.now()
        try {
          stateUpdater(draft => {
            draft.voiceList!.find(x => x.key == voice.key)!.numActiveUsers++
          })
          notifyCaller("onStart")
          await speech.play()
          notifyCaller("onEnd")
        }
        finally {
          stateUpdater(draft => {
            draft.voiceList!.find(x => x.key == voice.key)!.numActiveUsers--
          })
          const duration = Date.now() - start
          updateStats(stats => {
            if (!stats.voiceUsage) stats.voiceUsage = {}
            const hashKey = voice.key + (speakerName ?? "")
            stats.voiceUsage[hashKey] = (stats.voiceUsage[hashKey] ?? 0) + duration
          })
        }
      }
      catch (err: any) {
        if (err.name != "CancellationException") {
          reportError(err)
          notifyCaller("onError", {error: err})
        }
      }
      finally {
        if (currentSpeech == speech) currentSpeech = undefined
      }
    })
  }

  function onPause() {
    currentSpeech?.pause()
  }

  function onResume() {
    currentSpeech?.resume()
  }

  function onStop() {
    currentSpeech?.cancel()
    currentSpeech = undefined
  }

  function onForward() {
    currentSpeech?.forward()
  }

  function onRewind() {
    currentSpeech?.rewind()
  }

  function onSubmitTest(event: React.FormEvent) {
    event.preventDefault()
    const form = event.target as any
    if (form.text.value && form.voice.value) {
      onSpeak({utterance: form.text.value, voiceName: form.voice.value}, {send: console.log})
        .catch(reportError)
    }
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
