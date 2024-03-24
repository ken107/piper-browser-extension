
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
  },
  onEvent({method, args}) {
    if (speech && speech[method]) speech[method](args)
    else console.error("Unhandled event", method, args)
  }
})

chrome.runtime.onMessage.addListener(extDispatcher.dispatch)



//extension button action

chrome.action.onClicked.addListener(() => {
  piperHost.ready({requestFocus: true})
    .catch(console.error)
})



//ttsEngine commands

let speech

chrome.ttsEngine.onSpeak.addListener(async (utterance, options, sendTtsEvent) => {
  speech?.onError({error: {name: "CancellationException", message: "Playback cancelled"}})
  speech = null

  try {
    await piperHost.ready({requestFocus: false})
    await piperHost.sendRequest("speak", {utterance, ...options})
    await new Promise((fulfill, reject) => {
      speech = {
        onStart() {
          sendTtsEvent({type: "start"})
        },
        onSentence({startIndex, endIndex}) {
          sendTtsEvent({type: "sentence", charIndex: startIndex, length: endIndex-startIndex})
        },
        onParagraph({startIndex, endIndex}) {
          sendTtsEvent({type: "sentence", charIndex: startIndex, length: endIndex-startIndex})
        },
        onEnd() {
          fulfill()
        },
        onError({error}) {
          reject(error)
        }
      }
    })
    sendTtsEvent({type: "end"})
  }
  catch (err) {
    if (err instanceof Error) console.error(err)
    if (err.name != "CancellationException") {
      sendTtsEvent({type: "error", errorMessage: err.message})
    }
  }
  finally {
    speech = null
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
  speech?.onError({error: {name: "CancellationException", message: "Playback cancelled"}})
  speech = null

  piperHost.sendRequest("stop")
    .catch(console.error)
})
