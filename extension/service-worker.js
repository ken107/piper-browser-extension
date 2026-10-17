
const pocketHost = {
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
      await chrome.tabs.create({url: "index.html", pinned: true, active: requestFocus})
      await new Promise(f => this.serviceReadyTopic.subscribeOnce(f))
    }
  },
  async sendRequest(method, args) {
    const {error, result} = await chrome.runtime.sendMessage({
      to: "pocket-host",
      type: "request",
      id: String(Math.random()),
      method,
      args
    })
    return error ? Promise.reject(error) : result
  }
}



//process messages from pocket-host

importScripts("message-dispatcher.js")

const extDispatcher = makeDispatcher("service-worker", {
  pocketServiceReady() {
    pocketHost.serviceReadyTopic.publish()
  },
  onStart({speechId}) {
    chrome.ttsEngine.sendTtsEvent(speechId, {type: "start"})
  },
  onSentence({speechId, startIndex, endIndex}) {
    chrome.ttsEngine.sendTtsEvent(speechId, {type: "sentence", charIndex: startIndex, length: endIndex-startIndex})
  },
  onEnd({speechId}) {
    chrome.ttsEngine.sendTtsEvent(speechId, {type: "end"})
  },
  onError({speechId, error}) {
    chrome.ttsEngine.sendTtsEvent(speechId, {type: "error", errorMessage: error.message})
  }
})

chrome.runtime.onMessage.addListener(extDispatcher.dispatch)



//extension button action

chrome.action.onClicked.addListener(() => {
  pocketHost.ready({requestFocus: true})
    .catch(console.error)
})

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason == "install") {
    pocketHost.ready({requestFocus: true})
      .catch(console.error)
  }
})



//ttsEngine commands

chrome.ttsEngine.onSpeak.addListener(async (utterance, options, sendTtsEvent) => {
  try {
    const speechId = await new Promise(fulfill => {
      const tmp = chrome.ttsEngine.sendTtsEvent
      chrome.ttsEngine.sendTtsEvent = function(requestId) {
        chrome.ttsEngine.sendTtsEvent = tmp
        fulfill(requestId)
      }
      sendTtsEvent({type: "dummy"})
    })
    console.debug("speechId", speechId)
    await pocketHost.ready({requestFocus: false})
    await pocketHost.sendRequest("speak", {speechId, utterance, ...options})
  }
  catch (err) {
    console.error(err)
    sendTtsEvent({type: "error", errorMessage: err.message})
  }
})

chrome.ttsEngine.onPause.addListener(() => {
  pocketHost.sendRequest("pause")
    .catch(console.error)
})

chrome.ttsEngine.onResume.addListener(() => {
  pocketHost.sendRequest("resume")
    .catch(console.error)
})

chrome.ttsEngine.onStop.addListener(() => {
  pocketHost.sendRequest("stop")
    .catch(console.error)
})
