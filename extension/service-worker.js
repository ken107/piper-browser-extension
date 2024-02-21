
const piperHost = {
  async sendRequest(method, args) {
    const {error, result} = await chrome.runtime.sendMessage({to: "piper-host", type: "request", id: String(Math.random()), method, args})
    return error ? Promise.reject(error) : result
  }
}

chrome.ttsEngine.onSpeak.addListener(async (utterance, options, sendTtsEvent) => {
  try {
    const {speechId} = await piperHost.sendRequest("speak", {utterance, ...options})
    sendTtsEvent({type: "start"})
    await piperHost.sendRequest("wait", {speechId})
    sendTtsEvent({type: "end"})
  }
  catch (err) {
    sendTtsEvent({type: "error", errorMessage: err.message})
  }
})

chrome.ttsEngine.onPause.addListener(() => {
  piperHost.sendRequest("pause")
    .catch(console.error)
})

chrome.ttsEngine.onResume.addListener(() => {
  piperHost.sendRequest("resume")
    .catch(console.error)
})

chrome.ttsEngine.onStop.addListener(() => {
  piperHost.sendRequest("stop")
    .catch(console.error)
})



chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: "index.html"
  })
})
