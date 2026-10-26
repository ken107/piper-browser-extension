import * as React from "react"
import * as ReactDOM from "react-dom/client"
import * as rxjs from "rxjs"
import { useImmer } from "use-immer"
import { playAudio } from "./audio"
import config, { pocketModels, PocketModel } from "./config"
import { advertiseVoices, ensureServiceWorkerIsControlling, getInstallState, loadModel, saveModel, listDonatedVoices, loadVoiceList, messageDispatcher, parseAdvertisedVoiceName, registerVoice, sampler, uninstall } from "./services"
import { makeSpeech } from "./speech"
import { makeSynthesizer, SynthesisStats } from "./synthesizer"
import { InstallState, LoadState, MyVoice, PcmData, PlayAudio } from "./types"
import { assertNever, immediate, makeWav, printFileSize } from "./utils"

navigator.serviceWorker.register('./sw.js');

ReactDOM.createRoot(document.getElementById("app")!).render(<App />)


function App() {
  const [selectedModel, setSelectedModel] = React.useState(loadModel)
  const installing = React.useRef(false)
  const [installState, setInstallState] = React.useState<InstallState|null>(null)
  const [loadState, setLoadState] = React.useState<LoadState|null>(null)
  const [activityLog, setActivityLog] = React.useState("")
  const [showTestForm, setShowTestForm] = React.useState(() => self == top)
  const [showInfoBox, setShowInfoBox] = React.useState(false)
  const [showInstallDialog, setShowInstallDialog] = React.useState(false)
  const [waitingForExtensionInstall, setWaitingForExtensionInstall] = React.useState(false)
  const [showExtensionUninstallDialog, setShowExtensionUninstallDialog] = React.useState(false)
  const [installProgress, setInstallProgress] = useImmer<{ file: string, loaded: number, total: number|null }[]>([])
  const [perf, setPerf] = React.useState({ count: 0, audioSeconds: 0, synthSeconds: 0 })
  const [voiceList, setVoiceList] = React.useState<MyVoice[]|null>(null)
  const [pickedVoices, setPickedVoices] = React.useState<MyVoice[]>([])
  const [selectedVoice, setSelectedVoice] = React.useState('')
  const [donations, setDonations] = React.useState<{ voices: MyVoice[]|null, error?: unknown }|null>(null)
  const [donationFilter, setDonationFilter] = React.useState('')
  const [pauses, setPauses] = React.useState(loadPauses)
  const [test, testUpdater] = useImmer({
    current: null as null|{type: "speaking"}|{type: "synthesizing", percent: number},
    downloadUrl: null as string|null
  })

  const activityLogEl = React.useRef<HTMLTextAreaElement>(null)
  const synthesizer = React.useRef<ReturnType<typeof makeSynthesizer>>(null)
  const speech = React.useRef<ReturnType<typeof makeSpeech>>(null)

  const isInstalled = React.useMemo(() => {
    if (loadState == null) return null
    switch (loadState) {
      case 'not-installed':
      case 'installing': return false
      case 'installed':
      case 'loading':
      case 'loaded':
      case 'in-use': return true
      default: assertNever(loadState)
    }
  }, [
    loadState
  ])

  const loadStateText = React.useMemo(() => {
    if (loadState == null) return null
    switch (loadState) {
      case 'not-installed': return { text: 'Not Installed', statusColor: 'lightgray' }
      case 'installing': return { text: 'Installing', statusColor: 'orange' }
      case "installed": return { text: "Installed", statusColor: 'blue' }
      case "loading": return { text: 'Loading', statusColor: 'orange' }
      case "loaded": return { text: "Ready", statusColor: 'limegreen' }
      case 'in-use': return { text: 'In Use', statusColor: 'red' }
      default: assertNever(loadState)
    }
  }, [
    loadState
  ])


  //startup
  React.useEffect(() => {
    loadVoiceList()
      .then(setVoiceList)
      .catch(reportError)
    ensureServiceWorkerIsControlling().then(() => {
      getInstallState(selectedModel)
        .then(state => {
          setInstallState(state)
          setLoadState(state ? 'installed' : 'not-installed')
        })
        .catch(reportError)
    })
  }, [])

  //advertise voices
  React.useEffect(() => {
    if (isInstalled != null && voiceList != null)
      advertiseVoices(isInstalled ? voiceList : [])
  }, [
    isInstalled,
    voiceList
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
    if (activityLogEl.current)
      activityLogEl.current.scrollTop = activityLogEl.current.scrollHeight
  }, [
    activityLog
  ])

  // Poll install state while the dialog is open and the user is installing from the Web Store.
  React.useEffect(() => {
    if (!showInstallDialog || !waitingForExtensionInstall) return

    const subscription = rxjs.fromEvent(document, 'visibilitychange').pipe(
      rxjs.startWith(null),
      rxjs.switchMap(() => document.visibilityState == 'visible'
        ? rxjs.timer(0, 3000).pipe(
            rxjs.exhaustMap(() => rxjs.from(getInstallState(selectedModel)))
          )
        : rxjs.EMPTY
      )
    ).subscribe({
      next(state) {
        if (state?.repoType == 'extension') {
          setInstallState(state)
          setLoadState('installed')
          setWaitingForExtensionInstall(false)
          setShowInstallDialog(false)
        }
      },
      error: reportError
    })

    return () => subscription.unsubscribe()
  }, [
    showInstallDialog,
    waitingForExtensionInstall,
    selectedModel
  ])


  return (
    <div className="container">
      <div className="text-end text-muted small mt-1 mb-4">
        {isInstalled && !showTestForm && <>
          <span className="link"
            onClick={() => setShowTestForm(true)}>Show test form</span>
          <span className="mx-2">|</span>
        </>}
        <span className="link"
          onClick={() => setShowInfoBox(true)}>What is Pocket TTS?</span>
      </div>

      {showTestForm && <div>
        <h2 className="text-muted">Test</h2>
        <form>
          <textarea className="form-control" rows={3} name="text" defaultValue={config.testSpeech} />
          <select className="form-control mt-3" name="voice"
            value={selectedVoice} onChange={event => setSelectedVoice(event.target.value)}>
            <option value="">Select a voice</option>
            {isInstalled && voiceList?.map(voice =>
              <option key={voice.id} value={`PocketTTS ${voice.id}`}>{voice.label}</option>
            )}
            {isInstalled && pickedVoices.length > 0 &&
              <optgroup label="Voice donations">
                {pickedVoices.map(voice =>
                  <option key={voice.id} value={`PocketTTS ${voice.id}`}>{voice.label}</option>
                )}
              </optgroup>
            }
          </select>
          <div className="d-flex align-items-center mt-3">
            {test.current == null &&
              <button type="button" className="btn btn-primary" onClick={onTestSpeak}>Speak</button>
            }
            {test.current?.type == "speaking" &&
              <button type="button" className="btn btn-primary" disabled>Speak</button>
            }
            {location.hostname == "localhost" && test.current?.type == "speaking" &&
              <>
                <button type="button" className="btn btn-secondary ms-1" onClick={onPause}>Pause</button>
                <button type="button" className="btn btn-secondary ms-1" onClick={onResume}>Resume</button>
                <button type="button" className="btn btn-secondary ms-1" onClick={onForward}>Forward</button>
                <button type="button" className="btn btn-secondary ms-1" onClick={onRewind}>Rewind</button>
                <button type="button" className="btn btn-secondary ms-1"
                  onClick={() => onSeek({index: Number(prompt())})}>Seek</button>
              </>
            }
            {test.current == null &&
              <button type="button" className="btn btn-secondary ms-1" onClick={onTestSynthesize}>Download</button>
            }
            {test.current?.type == "synthesizing" &&
              <button type="button" className="btn btn-secondary ms-1" disabled>{test.current.percent}%</button>
            }
            {test.current &&
              <button type="button" className="btn btn-secondary ms-1" onClick={onStopTest}>Stop</button>
            }
            {test.downloadUrl &&
              <audio src={test.downloadUrl} controls className="ms-1" />
            }
          </div>
          {perf.count > 0 &&
            <div className="form-text">
              Speed: {(perf.audioSeconds / perf.synthSeconds).toFixed(2)}x real time
              (synthesized {perf.audioSeconds.toFixed(1)}s of audio in {perf.synthSeconds.toFixed(1)}s,
              {" "}{perf.count} sentence{perf.count == 1 ? '' : 's'}).
              Below 1x, playback will have gaps.
              <span className="link ms-2" onClick={() => setPerf({ count: 0, audioSeconds: 0, synthSeconds: 0 })}>reset</span>
            </div>
          }
        </form>
      </div>}

      {activityLog && <div>
        <h2 className="text-muted">Activity Log</h2>
        <textarea className="form-control" disabled rows={4} ref={activityLogEl} value={activityLog} />
      </div>}

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
                {installProgress.map(({ file, loaded, total }) => <div key={file} className="mt-1">
                  {file} {total
                    ? '[' + printFileSize(total) + '] ' + Math.round(100 * loaded / total) + '%'
                    : printFileSize(loaded)
                  }
                </div>)}
                <div className="mt-4">
                  {!isInstalled && <>
                    <button type="button" className="btn btn-primary"
                      disabled={loadState == null || loadState == 'installing' || voiceList == null}
                      onClick={onInstall}>Install</button>

                  </>}
                  {isInstalled &&
                    <button type="button" className="btn btn-outline-danger"
                      disabled={loadState == 'loading' || loadState == 'in-use'}
                      onClick={onUninstall}>Uninstall</button>
                  }
                </div>
              </td>
              <td valign="top" style={{width: '50%'}}>
                <table className="table table-borderless align-middle mb-0" aria-label="Options">
                  <tbody>
                    <tr>
                      <th scope="row" className="fw-normal"><label htmlFor="model">Model</label></th>
                      <td>
                        <select id="model" className="form-select" value={selectedModel.id}
                          aria-describedby="model-hint"
                          disabled={loadState == null || loadState == 'installing' || loadState == 'loading' || loadState == 'in-use' || voiceList == null}
                          onChange={event => onModelChange(event.target.value)}>
                          {pocketModels.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
                        </select>
                        <div id="model-hint" className="form-text">If speech is slow or has gaps, choose the faster 7m model. Changing models after installation installs the selected variant.</div>
                      </td>
                    </tr>
                    {isInstalled && ([
                      ['sentenceSilenceSeconds', 'Pause between sentences'],
                      ['paragraphSilenceSeconds', 'Pause between paragraphs'],
                    ] as const).map(([key, label]) =>
                      <tr key={key}>
                        <th scope="row" className="fw-normal"><label htmlFor={key}>{label}</label></th>
                        <td>
                          <div className="d-flex align-items-center">
                            <input type="number" id={key} className="form-control" style={{width: '6em'}}
                              disabled={loadState == 'in-use'}
                              min={0} max={5} step={0.05} value={pauses[key]}
                              onChange={e => {
                                const value = e.target.valueAsNumber
                                if (isNaN(value) || value < 0 || value > 5) return
                                const next = {...pauses, [key]: value}
                                setPauses(next)
                                savePauses(next)
                              }} />
                            <span className="ms-1">s</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
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
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
          {voiceList?.map(voice =>
            <tr key={voice.id}>
              <td>
                <span className="me-1">{voice.label}</span>
                <span className="link" onClick={() => sampler.play(voice)}>sample</span>
              </td>
              <td className="align-top">{voice.lang}</td>
              <td className="align-top">
                <a target="_blank" href={voice.sourceUrl}>{voice.source}</a>
                <span className="ms-1">(<a target="_blank" href={voice.clip}>{voice.license}</a>)</span>
              </td>
            </tr>
          )}
          </tbody>
        </table>
        <p className="text-muted small">
          Each voice is cloned in your browser from a reference clip
          in <a target="_blank" href="https://huggingface.co/kyutai/tts-voices">kyutai/tts-voices</a>.
        </p>
      </div>

      <div className="mb-4">
        <h2 className="text-muted">Voice Donations</h2>
        {donations == null &&
          <button type="button" className="btn btn-outline-secondary" onClick={onBrowseDonations}>Browse all donations</button>
        }
        {donations?.error != null &&
          <div className="text-danger">Could not load the voice donations: {String(donations.error)}</div>
        }
        {donations && !donations.voices && donations.error == null &&
          <div className="text-muted">Loading...</div>
        }
        {donations?.voices && <>
          <p className="text-muted small">
            Voices donated to the <a target="_blank" href="https://unmute.sh/voice-donation">Unmute Voice Donation Project</a> (CC0),
            listed live from <a target="_blank" href="https://huggingface.co/kyutai/tts-voices/tree/main/voice-donations">kyutai/tts-voices</a>.
            They are not curated: some are not in English, or are noisy, and the model only speaks English.
          </p>
          <input type="search" className="form-control mb-2" placeholder={`Search ${donations.voices.length} voices`}
            value={donationFilter} onChange={event => setDonationFilter(event.target.value)} />
          <div style={{maxHeight: 400, overflowY: 'auto'}}>
            <table className="table table-sm table-bordered">
              <tbody>
              {donations.voices
                .filter(voice => voice.label.toLowerCase().includes(donationFilter.trim().toLowerCase()))
                .map(voice =>
                  <tr key={voice.id}>
                    <td>
                      <span className="me-2">{voice.label}</span>
                      <span className="link me-2" onClick={() => sampler.play(voice)}>play clip</span>
                      {isInstalled &&
                        <span className="link" onClick={() => onUseDonatedVoice(voice)}>use in test form</span>
                      }
                    </td>
                  </tr>
                )
              }
              </tbody>
            </table>
          </div>
        </>}
      </div>

      <div className="text-center text-muted small mb-2">
        <span><a target="_blank" href="https://github.com/ken107/piper-browser-extension/tree/pockettts">
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

      {showInfoBox &&
        <div className="modal d-block" style={{backgroundColor: "rgba(0,0,0,.5)"}} tabIndex={-1} aria-hidden="true"
          onClick={e => e.target == e.currentTarget && setShowInfoBox(false)}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">What is Pocket TTS?</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => setShowInfoBox(false)}></button>
              </div>
              <div className="modal-body">
                <p>
                  Pocket TTS is a lightweight text-to-speech model developed by
                  {" "}<a target="_blank" href="https://huggingface.co/kyutai/pocket-tts">Kyutai</a>.
                  This page runs its small English models locally in your browser to turn text into speech.
                  You can choose a model in Options.
                </p>
                <p>
                  The model weights are licensed under
                  {" "}<a target="_blank" href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
                  {" "}and have been converted to
                  {" "}<a target="_blank" href="https://huggingface.co/ken107/pocket-tts-onnx">ONNX format</a>
                  {" "}for browser use.
                  Thanks to <a target="_blank" href="https://huggingface.co/KevinAHM/pocket-tts-onnx">KevinAHM</a> for
                  the original ONNX port.
                </p>
                <p>
                  Voice recordings have separate
                  {" "}<a target="_blank" href="https://huggingface.co/kyutai/tts-voices">licenses</a>.
                  Review the selected voice's terms before using or sharing generated audio.
                  Follow Kyutai's <a target="_blank" href="https://huggingface.co/kyutai/pocket-tts#prohibited-use">usage policy</a>:
                  do not impersonate anyone or clone a voice without explicit, lawful consent,
                  or use generated audio to deceive, defraud, or harm others.
                </p>
              </div>
            </div>
          </div>
        </div>
      }

      {showInstallDialog &&
        <div className="modal d-block" style={{backgroundColor: "rgba(0,0,0,.5)"}} tabIndex={-1} aria-hidden="true"
          onClick={e => {
            if (e.target == e.currentTarget) {
              setWaitingForExtensionInstall(false)
              setShowInstallDialog(false)
            }
          }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Install Voices</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => {
                    setWaitingForExtensionInstall(false)
                    setShowInstallDialog(false)
                  }}></button>
              </div>
              <div className="modal-body">
                <p>
                  For persistent installation, install the PocketTTS browser extension from{" "}
                  <a target="_blank" rel="noreferrer"
                    onClick={() => setWaitingForExtensionInstall(true)}
                    href={config.extensionStoreUrl ?? undefined}>
                    Chrome Web Store
                  </a>.
                  This is the recommended way to keep the voices installed permanently.
                </p>
                {waitingForExtensionInstall &&
                  <div className="d-flex align-items-center gap-2 text-primary mb-3" role="status" aria-live="polite">
                    <div className="spinner-border spinner-border-sm" aria-hidden="true"></div>
                    <span>Waiting for extension to be installed.</span>
                  </div>
                }
                <p>
                  Or you can install the voices to browser cache, but the browser may
                  automatically delete the files if disk space runs low.
                </p>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary"
                  onClick={() => {
                    setWaitingForExtensionInstall(false)
                    setShowInstallDialog(false)
                  }}>Cancel</button>
                <button type="button" className="btn btn-primary"
                  onClick={() => onInstallToBrowserCache()}>Install to browser cache</button>
              </div>
            </div>
          </div>
        </div>
      }

      {showExtensionUninstallDialog &&
        <div className="modal d-block" style={{backgroundColor: "rgba(0,0,0,.5)"}} tabIndex={-1} aria-hidden="true"
          onClick={e => e.target == e.currentTarget && setShowExtensionUninstallDialog(false)}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">Uninstall Voices</h5>
                <button type="button" className="btn-close" aria-label="Close"
                  onClick={() => setShowExtensionUninstallDialog(false)}></button>
              </div>
              <div className="modal-body">
                <p>
                  These voices are currently provided by the{" "}
                  <strong>PocketTTS Voices</strong> browser extension.
                </p>
                <p>
                  To remove them, uninstall or disable that extension from your browser's extensions page.
                </p>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-primary"
                  onClick={() => setShowExtensionUninstallDialog(false)}>Close</button>
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
    setActivityLog(log => log + text + '\n')
  }

  function onModelChange(id: string) {
    const model = pocketModels.find(model => model.id == id)
    if (!model || model.id == selectedModel.id || installing.current || speech.current || loadState == 'loading') return
    setSelectedModel(model)
    saveModel(model)
    if (isInstalled) onInstallToBrowserCache(model)
  }

  async function onInstall() {
    try {
      const state = await getInstallState(selectedModel)
      if (state) {
        setInstallState(state)
        setLoadState('installed')
      } else if (config.extensionStoreUrl) {
        setShowInstallDialog(true)
      } else {
        //no extension published yet, install straight to browser cache
        onInstallToBrowserCache()
      }
    } catch (err) {
      reportError(err)
    }
  }

  function onInstallToBrowserCache(model: PocketModel = selectedModel) {
    if (installing.current || speech.current) return
    installing.current = true
    setWaitingForExtensionInstall(false)
    setShowInstallDialog(false)
    navigator.storage.persist()
      .then(granted => console.info("Persistent storage:", granted))
      .catch(console.error)

    setLoadState('installing')
    setInstallProgress([])

    rxjs.fromEvent(navigator.serviceWorker, 'message', (e: MessageEvent) => e).pipe(
      rxjs.takeUntil(
        rxjs.defer(async () => {
          const previous = synthesizer.current
          synthesizer.current = null
          if (previous) await previous.dispose()
          synthesizer.current = createSynthesizer(model.repoPath)
          return synthesizer.current.readyPromise
            .then(async () => {
              //install the voice encoder and the voices' reference clips, the SW caches them
              await Promise.all([
                fetch(`${model.repoPath}/mimi_encoder_int8.onnx`),
                fetch(`${model.repoPath}/bos_before_voice.npy`),
                ...voiceList!.map(voice => fetch(voice.clip)),
              ].map(promise => promise.then(res => {
                if (!res.ok) throw new Error(`Failed to fetch ${res.url} (${res.status})`)
                return res.arrayBuffer()
              })))
            })
            .catch(async err => {
              //A download can fail after the engine is ready; release it before retrying.
              const failed = synthesizer.current
              synthesizer.current = null
              await failed?.dispose().catch(console.error)
              throw err
            })
        })
      )
    ).subscribe({
      next({ data: message }) {
        if (message.type == 'fetch-progress') {
          const { url, loaded, total } = message as { url: string, loaded: number, total: number|null }
          const file = url.split('/').pop()!
          setInstallProgress(draft => {
            const bucket = draft.find(x => x.file == file)
            if (bucket) bucket.loaded = loaded
            else draft.push({ file, loaded, total })
          })
        }
      },
      complete() {
        installing.current = false
        setPerf({ count: 0, audioSeconds: 0, synthSeconds: 0 })
        setInstallState({
          repoType: 'cache',
          repoPath: model.repoPath
        })
        setLoadState('loaded')
        setInstallProgress([])
        setShowTestForm(true)
      },
      error(err) {
        installing.current = false
        setInstallState(null)
        setInstallProgress([])
        setLoadState('not-installed')
        reportError(err)
      }
    })
  }

  function createSynthesizer(repoPath: string) {
    const start = performance.now()
    const synth = makeSynthesizer(repoPath, onSynthesized)
    synth.readyPromise
      .then(info => appendActivityLog(
        `Engine ready in ${((performance.now() - start) / 1000).toFixed(1)}s, using ${info.numThreads} of ${info.hardwareConcurrency} threads` +
        (info.crossOriginIsolated ? '' : ' (not cross-origin isolated, multi-threading unavailable)')
      ))
      .catch(() => {})
    return synth
  }

  function onSynthesized({ textLength, audioSeconds, synthSeconds }: SynthesisStats) {
    appendActivityLog(`Synthesized ${textLength} chars: ${audioSeconds.toFixed(1)}s of audio in ${synthSeconds.toFixed(1)}s (${(audioSeconds / synthSeconds).toFixed(2)}x real time)`)
    setPerf(p => ({ count: p.count + 1, audioSeconds: p.audioSeconds + audioSeconds, synthSeconds: p.synthSeconds + synthSeconds }))
  }

  async function onUninstall() {
    if (installState?.repoType == 'extension') {
      setShowExtensionUninstallDialog(true)
      return
    }

    if (!confirm("Are you sure you want to uninstall?")) return;
    try {
      if (synthesizer.current) {
        await synthesizer.current.dispose()
        synthesizer.current = null
      }
      await uninstall()
      setInstallState(null)
      setLoadState("not-installed")
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
          sender.send({to: "pocket-host", type: "request", id, method: "audioPlay", args: {src: wav, rate, volume}})
          const playing = {
            completePromise: messageDispatcher.waitForResponse<void>(id),
            pause() {
              sender.send({to:"pocket-host", type: "notification", method: "audioPause"})
              return {
                resume() {
                  sender.send({to: "pocket-host", type: "notification", method: "audioResume"})
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
        sender.send({to: "pocket-host", type: "notification", method, args})
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
        sender.send({to: "pocket-host", type: "notification", method, args})
      }
    })
  }

  function speak({text, voiceName, playAudio, callback}: {
    text: string,
    voiceName: string,
    playAudio: PlayAudio,
    callback(method: string, args?: Record<string, unknown>): void
  }) {
    if (installing.current) throw new Error('Model installation in progress')
    if (loadState == null) throw new Error('Service not yet available')
    switch (loadState) {
      case 'not-installed':
      case 'installing': throw new Error('Voices not installed')
      case 'installed': break
      case 'loading': throw new Error('Synthesizer not ready')
      case 'loaded': break
      case 'in-use': break    //will stop current speech
      default: assertNever(loadState)
    }

    const voiceId = parseAdvertisedVoiceName(voiceName)
    appendActivityLog(`Synthesizing '${text.slice(0,50).replace(/\s+/g,' ')}...' using voice ${voiceId}`)

    //create synthesizer if not yet
    if (!synthesizer.current) {
      appendActivityLog(`Initializing, please wait...`)
      synthesizer.current = createSynthesizer(installState!.repoPath)
    }

    //create speech
    speech.current?.cancel()
    const thisSpeech = speech.current = makeSpeech(synthesizer.current, {voiceId, text, numSteps: 1, ...pauses, playAudio}, {
      onSentence(startIndex, endIndex) {
        notifyCaller("onSentence", {startIndex, endIndex})
      }
    })
    function notifyCaller(method: string, args?: Record<string, unknown>) {
      if (speech.current == thisSpeech)
        callback(method, args)
    }

    immediate(async () => {
      try {
        //wait synthesizer ready
        if ((loadState satisfies 'installed'|'loaded'|'in-use') == 'installed') {
          setLoadState("loading")
          try {
            await synthesizer.current!.readyPromise
            setLoadState("loaded")
          }
          catch (err) {
            synthesizer.current = null
            setLoadState('installed')
            throw err
          }
        }

        //play speech
        try {
          setLoadState('in-use')
          //the first use of a voice clones it from its clip, which takes a moment; hold off onStart
          //until it's done so the caller's progress indicator covers it
          await synthesizer.current!.prepareVoice(voiceId)
          if (speech.current != thisSpeech) return
          notifyCaller("onStart", {sentenceStartIndicies: thisSpeech.sentenceStartIndicies})
          await thisSpeech.play()
          notifyCaller("onEnd")
        }
        finally {
          if (speech.current == thisSpeech)
            setLoadState('loaded')
        }
      }
      catch (err: any) {
        if (err.name != "CancellationException") {
          reportError(err)
          notifyCaller("onError", {error: err})
        }
      }
      finally {
        if (speech.current == thisSpeech)
          speech.current = null
      }
    })
  }

  function onPause() {
    speech.current?.pause()
  }

  function onResume() {
    speech.current?.resume()
  }

  function onStop() {
    speech.current?.cancel()
  }

  function onForward() {
    speech.current?.forward()
  }

  function onRewind() {
    speech.current?.rewind()
  }

  function onSeek({index}: Record<string, unknown>) {
    if (typeof index != "number") throw new Error("Bad args")
    speech.current?.seek(index)
  }

  function onBrowseDonations() {
    setDonations({ voices: null })
    listDonatedVoices()
      .then(voices => setDonations({ voices }))
      .catch(error => setDonations({ voices: null, error }))
  }

  //donated clips aren't installed, the SW caches each one when it is first used
  function onUseDonatedVoice(voice: MyVoice) {
    registerVoice(voice)
    setPickedVoices(voices => voices.some(x => x.id == voice.id) ? voices : [...voices, voice])
    setSelectedVoice(`PocketTTS ${voice.id}`)
    setShowTestForm(true)
    scrollTo({ top: 0, behavior: 'smooth' })
  }

  function onTestSpeak(event: React.MouseEvent<HTMLButtonElement>) {
    const form = (event.target as HTMLButtonElement).form
    if (form?.text.value && form.voice.value) {
      if (test.downloadUrl) {
        URL.revokeObjectURL(test.downloadUrl)
      }
      testUpdater(draft => {
        draft.downloadUrl = null
        draft.current = {type: "speaking"}
      })
      try {
        onSpeak({utterance: form.text.value, voiceName: form.voice.value}, {
          send({method, args}: {method: string, args?: Record<string, unknown>}) {
            console.log(method, args)
            if (method == "onEnd") {
              testUpdater(draft => {
                draft.current = null
              })
            }
          }
        })
      } catch (err) {
        reportError(err)
        testUpdater(draft => {
          draft.current = null
        })
      }
    }
  }

  function onTestSynthesize(event: React.MouseEvent<HTMLButtonElement>) {
    const form = (event.target as HTMLButtonElement).form!
    const text = form.text.value
    const voiceName = form.voice.value
    if (text && voiceName) {
      if (test.downloadUrl) {
        URL.revokeObjectURL(test.downloadUrl)
      }
      testUpdater(draft => {
        draft.downloadUrl = null
        draft.current = {type: "synthesizing", percent: 0}
      })
      onSynthesize({text, voiceName}, {
        send({method, args}: {method: string, args?: Record<string, unknown>}) {
          console.log(method, args)
          if (method == "onEnd") {
            testUpdater(draft => {
              draft.current = null
              if (args?.audioBlob instanceof Blob) {
                draft.downloadUrl = URL.createObjectURL(args.audioBlob)
              }
            })
          }
          else if (method == "onSentence") {
            testUpdater(draft => {
              if (draft.current?.type == "synthesizing" && typeof args?.startIndex == "number") {
                draft.current.percent = Math.round(100 * args.startIndex / text.length)
              }
            })
          }
        }
      })
    }
  }

  function onStopTest() {
    onStop()
    testUpdater(draft => {
      draft.current = null
    })
  }
}


//pause settings persist in localStorage, which may be unavailable
function loadPauses() {
  const defaults = {
    sentenceSilenceSeconds: config.sentenceSilenceSeconds,
    paragraphSilenceSeconds: config.paragraphSilenceSeconds,
  }
  try {
    const saved = JSON.parse(localStorage.getItem('pauses') ?? 'null')
    if (saved && typeof saved.sentenceSilenceSeconds == 'number' && typeof saved.paragraphSilenceSeconds == 'number')
      return {sentenceSilenceSeconds: saved.sentenceSilenceSeconds, paragraphSilenceSeconds: saved.paragraphSilenceSeconds}
  }
  catch {}
  return defaults
}

function savePauses(pauses: ReturnType<typeof loadPauses>) {
  try {
    localStorage.setItem('pauses', JSON.stringify(pauses))
  }
  catch {}
}
