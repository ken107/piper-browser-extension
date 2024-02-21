
const piperHost = {
  serviceReadyTopic: {
    callbacks: [],
    publish() {
      for (const callback of this.callbacks) callback()
      this.callbacks = []
    },
    subscribeOnce(callback) {
      this.callbacks.push(callback)
    }
  },
  async ready({requestFocus}) {
    try {
      if (!await this.sendRequest("areYouThere", {requestFocus})) throw "Absent"
    }
    catch (err) {
      await chrome.tabs.create({
        url: "index.html",
        pinned: true,
        active: requestFocus
      })
      await new Promise(f => this.serviceReadyTopic.subscribeOnce(f))
    }
  },
  async sendRequest(method, args) {
    const {error, result} = await chrome.runtime.sendMessage({
      to: "piper-host",
      type: "request",
      id: String(Math.random()),
      method,
      args
    })
    return error ? Promise.reject(error) : result
  }
}



//process messages from piper-host

importScripts("message-dispatcher.js")

const extDispatcher = makeDispatcher("service-worker", {
  piperServiceReady() {
    piperHost.serviceReadyTopic.publish()
  }
})

chrome.runtime.onMessage.addListener(extDispatcher.dispatch)



//extension button action

chrome.action.onClicked.addListener(() => {
  piperHost.ready({requestFocus: true})
    .catch(console.error)
})



//ttsEngine commands

let currentSpeech

chrome.ttsEngine.onSpeak.addListener(async (utterance, options, sendTtsEvent) => {
  try {
    await piperHost.ready({requestFocus: false})
    currentSpeech = await piperHost.sendRequest("speak", {utterance, ...options})
    sendTtsEvent({type: "start"})
    await piperHost.sendRequest("wait", currentSpeech)
    sendTtsEvent({type: "end"})
  }
  catch (err) {
    sendTtsEvent({type: "error", errorMessage: err.message})
  }
})

chrome.ttsEngine.onPause.addListener(() => {
  piperHost.sendRequest("pause", currentSpeech)
    .catch(console.error)
})

chrome.ttsEngine.onResume.addListener(() => {
  piperHost.sendRequest("resume", currentSpeech)
    .catch(console.error)
})

chrome.ttsEngine.onStop.addListener(() => {
  if (currentSpeech) {
    piperHost.sendRequest("stop", currentSpeech)
      .catch(console.error)
  }
})
