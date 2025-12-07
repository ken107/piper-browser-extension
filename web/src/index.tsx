import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { playAudio } from "./audio"
import config from "./config"
import { advertiseVoices, getInstallState, install, messageDispatcher, parseAdvertisedVoiceName, sampler, uninstall } from "./services"
import { makeSpeech } from "./speech"
import { makeSynthesizer } from "./synthesizer"
import { Installable, LoadState, PcmData, PlayAudio } from "./types"
import { getContentLengths, immediate, makeWav, printMegabytes } from "./utils"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)

const query = new URLSearchParams(location.search)
let synthesizer: ReturnType<typeof makeSynthesizer> | undefined
let currentSpeech: ReturnType<typeof makeSpeech>|undefined


function App() {
  const [state, stateUpdater] = useImmer({
    installables: null as Installable[]|null,
    loadState: null as LoadState|null,
    numSteps: 5,
    activityLog: "",
    showInfoBox: false,
    test: {
      current: null as null|{type: "speaking"}|{type: "synthesizing", percent: number},
      downloadUrl: null as string|null
    }
  })

  const refs = {
    activityLog: React.useRef<HTMLTextAreaElement>(null!),
  }

  const isInstalled = React.useMemo<boolean|null>(() => {
    if (state.loadState == null)
      return null
    switch (state.loadState.type) {
      case 'in-use':
      case 'installed':
      case 'loaded':
      case 'loading':
        return true
      case 'installing':
      case 'not-installed':
        return false
    }
  }, [
    state.loadState
  ])

  const loadStateText = React.useMemo(() => {
    if (state.loadState == null)
      return null
    switch (state.loadState.type) {
      case 'not-installed': return { text: 'Not Installed', statusColor: 'gray' }
      case 'installing': return { text: 'Installing ' + state.loadState.progress, statusColor: 'yellow' }
      case "installed": return { text: "Installed", statusColor: 'blue' }
      case "loading": return { text: 'Loading', statusColor: 'yellow' }
      case "loaded": return { text: "Ready", statusColor: 'green' }
      case 'in-use': return { text: 'In Use', statusColor: 'red' }
    }
  }, [
    state.loadState
  ])

  const installSizeText = React.useMemo(() => {
    if (state.installables == null)
      return null
    const size = state.installables.reduce((sum: number|null, {size}) => sum != null && size != null ? sum + size : null, 0)
    if (size == null)
      return null
    return printMegabytes(size)
  }, [
    state.installables
  ])


  //startup
  React.useEffect(() => {
    getInstallState()
      .then(installState => stateUpdater(draft => { draft.loadState = installState }))
      .catch(reportError)
  }, [])

  //advertise voices
  React.useEffect(() => {
    if (isInstalled != null)
      advertiseVoices(isInstalled ? config.voiceList : [])
  }, [
    isInstalled
  ])

  //installables
  React.useEffect(() => {
    if (isInstalled != null) {
      if (!isInstalled && !state.installables) {
        getContentLengths(config.installables).then(results =>
          stateUpdater(draft => {
            draft.installables = results.map((result, i) => ({
              url: config.installables[i],
              size: result.status == 'fulfilled' ? result.value : null
            }))
          })
        ).catch(reportError)
      }
    }
  }, [
    isInstalled, state.installables
  ])

  //handle requests
  React.useEffect(() => {
    messageDispatcher.updateHandlers({
      speak: onSpeak,
      synthesize: onSynthesize,
      pause: onPause,
      resume: onResume,
      stop: onStop,
      forward: onForward,
      rewind: onRewind,
      seek: onSeek,
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
          onClick={() => stateUpdater(draft => {draft.showInfoBox = true})}>What is Supertonic?</span>
      </div>

      {(query.has("showTest") ? query.get("showTest") != "0" : top == self) &&
        <div>
          <h2 className="text-muted">Test</h2>
          <form>
            <textarea className="form-control" rows={3} name="text" defaultValue={config.testSpeech} />
            <select className="form-control mt-3" name="voice">
              <option value="">Select a voice</option>
              {isInstalled && config.voiceList.map(voice =>
                <option key={voice.id} value={voice.id}>{voice.id}</option>
              )}
            </select>
            <div className="d-flex align-items-center mt-3">
              {state.test.current == null &&
                <button type="button" className="btn btn-primary" onClick={onTestSpeak}>Speak</button>
              }
              {state.test.current?.type == "speaking" &&
                <button type="button" className="btn btn-primary" disabled>Speak</button>
              }
              {location.hostname == "localhost" && state.test.current?.type == "speaking" &&
                <>
                  <button type="button" className="btn btn-secondary ms-1" onClick={onPause}>Pause</button>
                  <button type="button" className="btn btn-secondary ms-1" onClick={onResume}>Resume</button>
                  <button type="button" className="btn btn-secondary ms-1" onClick={onForward}>Forward</button>
                  <button type="button" className="btn btn-secondary ms-1" onClick={onRewind}>Rewind</button>
                  <button type="button" className="btn btn-secondary ms-1"
                    onClick={() => onSeek({index: Number(prompt())})}>Seek</button>
                </>
              }
              {state.test.current == null &&
                <button type="button" className="btn btn-secondary ms-1" onClick={onTestSynthesize}>Download</button>
              }
              {state.test.current?.type == "synthesizing" &&
                <button type="button" className="btn btn-secondary ms-1" disabled>{state.test.current.percent}%</button>
              }
              {state.test.current &&
                <button type="button" className="btn btn-secondary ms-1" onClick={onStopTest}>Stop</button>
              }
              {state.test.downloadUrl &&
                <audio src={state.test.downloadUrl} controls className="ms-1" />
              }
            </div>
          </form>
        </div>
      }

      <div>
        <h2 className="text-muted">Activity Log</h2>
        <textarea className="form-control" disabled rows={4} ref={refs.activityLog} value={state.activityLog} />
      </div>

      <div>
        <h2 className="text-muted">Install</h2>
        <table className="table table-bordered">
          <thead className="table-light">
            <tr>
              <th>Status</th>
              <th>Options</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div style={{fontSize: 'larger'}}>
                  {loadStateText && <>
                    <span style={{color: loadStateText.statusColor}}>●</span>
                    <span className="ms-1">{loadStateText.text}</span>
                  </>}
                </div>
                <div className="mt-4">
                  {isInstalled == false && <>
                    <button type="button" className="btn btn-primary"
                      disabled={state.loadState?.type == 'installing'}
                      onClick={onInstall}>Install</button>
                    <span className="ms-2">{installSizeText}</span>
                  </>}
                  {isInstalled == true &&
                    <button type="button" className="btn btn-danger"
                      disabled={state.loadState?.type == 'loading' || state.loadState?.type == 'in-use'}
                      onClick={onUninstall}>Uninstall</button>
                  }
                </div>
              </td>
              <td valign="top" style={{width: '50%'}}>
                <label htmlFor="numSteps">Quality (Steps)</label>
                <input type="number" className="form-control" id="numSteps" required min="1" max="16"
                  value={state.numSteps}
                  onChange={event => stateUpdater(draft => { draft.numSteps = Number(event.target.value) })} />
                <div className="form-text">
                  Decrease quality if you experience speech gaps between sentences.
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <h2 className="text-muted">Voice List</h2>
        <table className="table table-bordered">
          <thead className="table-light">
            <tr>
              <th>Voice</th>
              <th>Language</th>
            </tr>
          </thead>
          <tbody>
          {config.voiceList.map(voice =>
            <tr key={voice.id}>
              <td>
                <span className="me-1">{voice.id}</span>
                <span className="link" onClick={() => sampler.play(voice)}>sample</span>
              </td>
              <td className="align-top">{voice.lang}</td>
            </tr>
          )}
          </tbody>
        </table>
      </div>

      <div className="text-center text-muted small mb-2">
        <span><a target="_blank" href="https://github.com/ken107/piper-browser-extension">
          <svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 240 240" preserveAspectRatio="xMidYMid meet">
            <g transform="translate(0, 240) scale(0.1, -0.1)" fill="#666666" stroke="none">
              <path d="M970 2301 c-305 -68 -555 -237 -727 -493 -301 -451 -241 -1056 143 -1442 115 -116 290 -228 422 -271 49 -16 55 -16 77 -1 24 16 25 20 25 135 l0 118 -88 -5 c-103 -5 -183 13 -231 54 -17 14 -50 62 -73 106 -38 74 -66 108 -144 177 -26 23 -27 24 -9 37 43 32 130 1 185 -65 96 -117 133 -148 188 -160 49 -10 94 -6 162 14 9 3 21 24 27 48 6 23 22 58 35 77 l24 35 -81 16 c-170 35 -275 96 -344 200 -64 96 -85 179 -86 334 0 146 16 206 79 288 28 36 31 47 23 68 -15 36 -11 188 5 234 13 34 20 40 47 43 45 5 129 -24 214 -72 l73 -42 64 15 c91 21 364 20 446 0 l62 -16 58 35 c77 46 175 82 224 82 39 0 39 -1 55 -52 17 -59 20 -166 5 -217 -8 -30 -6 -39 16 -68 109 -144 121 -383 29 -579 -62 -129 -193 -219 -369 -252 l-84 -16 31 -55 32 -56 3 -223 4 -223 25 -16 c23 -15 28 -15 76 2 80 27 217 101 292 158 446 334 590 933 343 1431 -145 293 -419 518 -733 602 -137 36 -395 44 -525 15z" />
            </g>
          </svg>
        </a> &mdash; </span>
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
                <h5 className="modal-title">What is Supertonic?</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => stateUpdater(draft => {draft.showInfoBox = false})}></button>
              </div>
              <div className="modal-body">
                <p>
                  Supertonic is a collection of AI-powered text-to-speech voices developed by Supertone, Inc.
                  (<a target="_blank" href="https://github.com/supertone-inc/supertonic">GitHub</a>
                  , <a target="_blank" href="https://huggingface.co/Supertone/supertonic">HuggingFace</a>).
                  These voices are synthesized in-browser, requiring no cloud subscriptions, and are entirely
                  free to use.
                </p>
                <p>
                  You can use them to read aloud web pages and documents with
                  the <a target="_blank" href="https://readaloud.app">Read Aloud</a> extension,
                  or make them generally available to all browser apps through
                  the <a target="_blank" href="https://ttstool.com/redirect.html?target=supertonic-tts-extension">Supertonic TTS</a> extension.
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

  function onInstall() {
    navigator.storage.persist()
      .then(granted => console.info("Persistent storage:", granted))
      .catch(console.error)
    install(state.installables!).subscribe({
      next({ loaded, total }) {
        stateUpdater(draft => {
          draft.loadState = {
            type: 'installing',
            progress: total != null
              ? Math.round(100 * loaded / total) + '%'
              : printMegabytes(loaded)
          }
        })
      },
      complete() {
        stateUpdater(draft => {
          draft.loadState = { type: "installed" }
        })
      },
      error(err) {
        reportError(err)
      }
    })
  }

  async function onUninstall() {
    if (!confirm("Are you sure you want to uninstall?")) return;
    try {
      await synthesizer?.dispose()
      await uninstall()
      stateUpdater(draft => {
        draft.loadState = { type: "not-installed" }
      })
    }
    catch (err) {
      reportError(err)
    }
  }

  function onSpeak(
    {utterance, voiceName, pitch, rate, volume, externalPlayback}: Record<string, unknown>,
    sender: {send(message: unknown): void}
  ) {
    if (!(
      typeof utterance == "string" &&
      typeof voiceName == "string" &&
      (typeof pitch == "number" || typeof pitch == "undefined") &&
      (typeof rate == "number" || typeof rate == "undefined") &&
      (typeof volume == "number" || typeof volume == "undefined") &&
      (typeof externalPlayback == "boolean" || typeof externalPlayback == "undefined")
    )) {
      throw new Error("Bad args")
    }
    speak({
      text: utterance,
      voiceName,
      playAudio(pcmData, appendSilenceSeconds) {
        if (externalPlayback) {
          const wav = makeWav([{pcmData, appendSilenceSeconds}])
          const id = String(Math.random())
          sender.send({to: "piper-host", type: "request", id, method: "audioPlay", args: {src: wav, rate, volume}})
          const playing = {
            completePromise: messageDispatcher.waitForResponse<void>(id),
            pause() {
              sender.send({to:"piper-host", type: "notification", method: "audioPause"})
              return {
                resume() {
                  sender.send({to: "piper-host", type: "notification", method: "audioResume"})
                  return playing
                }
              }
            }
          }
          return playing
        } else {
          return playAudio(pcmData, appendSilenceSeconds, pitch, rate, volume)
        }
      },
      callback(method, args) {
        sender.send({to: "piper-host", type: "notification", method, args})
      }
    })
  }

  function onSynthesize(
    {text, voiceName, pitch}: Record<string, unknown>,
    sender: {send(message: unknown): void}
  ) {
    if (!(
      typeof text == "string" &&
      typeof voiceName == "string" &&
      (typeof pitch == "number" || typeof pitch == "undefined")
    )) {
      throw new Error("Bad args")
    }
    const chunks = [] as Array<{pcmData: PcmData, appendSilenceSeconds: number}>
    speak({
      text,
      voiceName,
      playAudio(pcmData, appendSilenceSeconds) {
        chunks.push({pcmData, appendSilenceSeconds})
        const playing = {
          completePromise: Promise.resolve(),
          pause: () => ({resume: () => playing})
        }
        return playing
      },
      callback(method, args) {
        if (method == "onEnd") args = {...args, audioBlob: makeWav(chunks)}
        sender.send({to: "piper-host", type: "notification", method, args})
      }
    })
  }

  function speak({text, voiceName, playAudio, callback}: {
    text: string,
    voiceName: string,
    playAudio: PlayAudio,
    callback(method: string, args?: Record<string, unknown>): void
  }) {
    const voiceId = parseAdvertisedVoiceName(voiceName)
    appendActivityLog(`Synthesizing '${text.slice(0,50).replace(/\s+/g,' ')}...' using voice ${voiceId}`)

    if (!synthesizer) {
      appendActivityLog(`Initializing, please wait...`)
      synthesizer = makeSynthesizer()
    }

    currentSpeech?.cancel()
    const speech = currentSpeech = makeSpeech(synthesizer, {voiceId, text, numSteps: state.numSteps, playAudio}, {
      onSentence(startIndex, endIndex) {
        notifyCaller("onSentence", {startIndex, endIndex})
      }
    })
    function notifyCaller(method: string, args?: Record<string, unknown>) {
      if (speech == currentSpeech)
        callback(method, args)
    }

    immediate(async () => {
      try {
        switch (state.loadState?.type) {
          case 'installed':
            try {
              stateUpdater(draft => {
                draft.loadState = { type: "loading" }
              })
              await synthesizer!.readyPromise
            }
            finally {
              stateUpdater(draft => {
                draft.loadState = { type: "loaded" }
              })
            }
            break
          case 'loaded':
            break
          default:
            throw new Error('Synthesizer not ready')
        }

        try {
          stateUpdater(draft => {
            draft.loadState = { type: 'in-use' }
          })
          notifyCaller("onStart", {sentenceStartIndicies: speech.sentenceStartIndicies})
          await speech.play()
          notifyCaller("onEnd")
        }
        finally {
          stateUpdater(draft => {
            draft.loadState = { type: 'loaded'}
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

  function onSeek({index}: Record<string, unknown>) {
    if (typeof index != "number") throw new Error("Bad args")
    currentSpeech?.seek(index)
  }

  function onTestSpeak(event: React.MouseEvent<HTMLButtonElement>) {
    const form = (event.target as HTMLButtonElement).form
    if (form?.text.value && form.voice.value) {
      if (state.test.downloadUrl) URL.revokeObjectURL(state.test.downloadUrl)
      stateUpdater(draft => {
        draft.test.downloadUrl = null
        draft.test.current = {type: "speaking"}
      })
      onSpeak({utterance: form.text.value, voiceName: form.voice.value}, {
        send({method, args}: {method: string, args?: Record<string, unknown>}) {
          console.log(method, args)
          if (method == "onEnd") {
            stateUpdater(draft => {
              draft.test.current = null
            })
          }
        }
      })
    }
  }

  function onTestSynthesize(event: React.MouseEvent<HTMLButtonElement>) {
    const form = (event.target as HTMLButtonElement).form!
    const text = form.text.value
    const voiceName = form.voice.value
    if (text && voiceName) {
      if (state.test.downloadUrl) URL.revokeObjectURL(state.test.downloadUrl)
      stateUpdater(draft => {
        draft.test.downloadUrl = null
        draft.test.current = {type: "synthesizing", percent: 0}
      })
      onSynthesize({text, voiceName}, {
        send({method, args}: {method: string, args?: Record<string, unknown>}) {
          console.log(method, args)
          if (method == "onEnd") {
            stateUpdater(draft => {
              draft.test.current = null
              if (args?.audioBlob instanceof Blob) draft.test.downloadUrl = URL.createObjectURL(args.audioBlob)
            })
          }
          else if (method == "onSentence") {
            stateUpdater(draft => {
              if (draft.test.current?.type == "synthesizing" && typeof args?.startIndex == "number")
                draft.test.current.percent = Math.round(100 * args.startIndex / text.length)
            })
          }
        }
      })
    }
  }

  function onStopTest() {
    onStop()
    stateUpdater(draft => {
      draft.test.current = null
    })
  }
}
