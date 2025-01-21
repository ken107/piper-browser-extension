import * as React from "react"
import * as ReactDOM from "react-dom/client"
import { useImmer } from "use-immer"
import { playAudio } from "./audio"
import config from "./config"
import { advertiseVoices, makeAdvertisedVoiceList, messageDispatcher, parseAdvertisedVoiceName } from "./services"
import { makeSpeech } from "./speech"
import { modelStatus$, synthesize } from "./synthesizer"
import { AdvertisedVoice, PcmData, PlayAudio } from "./types"
import { immediate, makeWav } from "./utils"

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)

const query = new URLSearchParams(location.search)
let currentSpeech: ReturnType<typeof makeSpeech>|undefined


export function App() {
  const [state, stateUpdater] = useImmer({
    advertisedVoices: [] as AdvertisedVoice[],
    isInstalled: localStorage.getItem("isInstalled") ? true : false,
    modelStatus: modelStatus$.value,
    numActiveUsers: 0,
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


  //startup
  React.useEffect(() => {
    const subs = [
      modelStatus$.subscribe(value => {
        stateUpdater(draft => {
          draft.modelStatus = value
        })
      })
    ]
    return () => subs.forEach(sub => sub.unsubscribe())
  }, [])

  //advertise voices
  React.useEffect(() => {
    if (state.isInstalled) {
      makeAdvertisedVoiceList()
        .then(result => {
          stateUpdater(draft => {
            draft.advertisedVoices = result
          })
        })
        .catch(err => {
          console.error("Fail makeAdvertisedVoiceList", err)
        })
    } else {
      stateUpdater(draft => {
        draft.advertisedVoices = []
      })
    }
  }, [
    state.isInstalled
  ])

  React.useEffect(() => {
    advertiseVoices(state.advertisedVoices)
  }, [
    state.advertisedVoices
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
          onClick={() => stateUpdater(draft => {draft.showInfoBox = true})}>What is Kokoro?</span>
      </div>

      <div>
        <h2 className="text-muted">Model</h2>
        <table className="table table-borderless">
          <tbody>
            <tr>
              <td>
                <div>Kokoro 82M</div>
                <div className="text-muted" style={{fontSize: "smaller"}}>This model is licensed under the <a href="https://www.apache.org/licenses/LICENSE-2.0.txt">Apache 2.0 License</a>.</div>
              </td>
              {!state.isInstalled &&
                <>
                  <td className="text-end">92.4MB</td>
                  <td className="text-end ps-2" style={{width: 0}}>
                    <button type="button" className="btn btn-success btn-sm"
                      onClick={onInstall}>Install</button>
                  </td>
                </>
              }
              {state.isInstalled &&
                <>
                  <td>
                    {immediate(() => {
                      switch (state.modelStatus.status) {
                        case "unloaded":
                          return "UNLOADED"
                        case "loading":
                          return <span style={{fontWeight: "bold", color: "red"}}>LOADING {Math.round(state.modelStatus.percent)}%</span>
                        case "ready":
                          return state.numActiveUsers ? <span style={{fontWeight: "bold"}}>BUSY</span> : "READY"
                      }
                    })}
                  </td>
                  <td className="text-end ps-2">
                    <button type="button" className="btn btn-danger btn-sm"
                      onClick={onDelete}>Delete</button>
                  </td>
                </>
              }
            </tr>
          </tbody>
        </table>
      </div>

      {(query.has("showTest") ? query.get("showTest") != "0" : top == self) &&
        <div>
          <h2 className="text-muted">Test</h2>
          <form>
            <textarea className="form-control" rows={3} name="text" defaultValue={config.testSpeech} />
            <select className="form-control mt-3" name="voice">
              <option value="">Select a voice</option>
              {state.advertisedVoices.map(voice =>
                <option key={voice.voiceName} value={voice.voiceName}>{voice.voiceName}</option>
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

      <div className="text-center text-muted small mb-2">
        <span><a target="_blank" href="https://github.com/ken107/piper-browser-extension/tree/kokoro">
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
                <h5 className="modal-title">What is Kokoro?</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => stateUpdater(draft => {draft.showInfoBox = false})}></button>
              </div>
              <div className="modal-body">
                Kokoro is a collection of high-quality, open-source text-to-speech voices developed by
                the <a target="_blank" href="https://huggingface.co/hexgrad/Kokoro-82M">Kokoro Project</a>,
                powered by machine learning technology.
                These voices are synthesized in-browser, requiring no cloud subscriptions, and are entirely
                free to use.
                You can use them to read aloud web pages and documents with
                the <a target="_blank" href="https://readaloud.app">Read Aloud</a> extension,
                or make them generally available to all browser apps through
                the <a target="_blank" href="https://ttstool.com/redirect.html?target=kokoro-tts-extension">Kokoro TTS</a> extension.
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
    stateUpdater(draft => {
      draft.isInstalled = true
    })
    localStorage.setItem("isInstalled", "1")
    synthesize("Hello world", "af_bella")
      .catch(err => console.error("Fail install", err))
  }

  function onDelete() {
    stateUpdater(draft => {
      draft.isInstalled = false
    })
    localStorage.removeItem("isInstalled")
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
          sender.send({to: "tts-host", type: "request", id, method: "audioPlay", args: {src: wav, rate, volume}})
          const playing = {
            completePromise: messageDispatcher.waitForResponse<void>(id),
            pause() {
              sender.send({to:"tts-host", type: "notification", method: "audioPause"})
              return {
                resume() {
                  sender.send({to: "tts-host", type: "notification", method: "audioResume"})
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
        sender.send({to: "tts-host", type: "notification", method, args})
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
        sender.send({to: "tts-host", type: "notification", method, args})
      }
    })
  }

  function speak({text, voiceName, playAudio, callback}: {
    text: string,
    voiceName: string,
    playAudio: PlayAudio,
    callback(method: string, args?: Record<string, unknown>): void
  }) {
    const {voiceId} = parseAdvertisedVoiceName(voiceName)
    appendActivityLog(`Synthesizing '${text.slice(0,50).replace(/\s+/g,' ')}...' using ${voiceId}`)

    currentSpeech?.cancel()
    const speech = currentSpeech = makeSpeech({voiceId, text, playAudio}, {
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
        try {
          stateUpdater(draft => {
            draft.numActiveUsers++
          })
          notifyCaller("onStart", {sentenceStartIndicies: speech.sentenceStartIndicies})
          await speech.play()
          notifyCaller("onEnd")
        }
        finally {
          stateUpdater(draft => {
            draft.numActiveUsers--
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
