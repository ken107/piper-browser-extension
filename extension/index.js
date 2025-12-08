
let supertonicService
let speechId


//handle messages from supertonic-service

const domDispatcher = makeDispatcher("supertonic-host", {
  advertiseVoices({voices}, sender) {
    chrome.ttsEngine.updateVoices(voices)
    supertonicService = sender
    notifyServiceWorker("supertonicServiceReady")
  },
  onStart(args) {
    notifyServiceWorker("onStart", {...args, speechId})
  },
  onSentence(args) {
    notifyServiceWorker("onSentence", {...args, speechId})
  },
  onEnd(args) {
    notifyServiceWorker("onEnd", {...args, speechId})
  },
  onError(args) {
    notifyServiceWorker("onError", {...args, speechId})
  }
})

window.addEventListener("message", event => {
  const send = message => event.source.postMessage(message, {targetOrigin: event.origin})
  const sender = {
    sendRequest(method, args) {
      const id = String(Math.random())
      send({to: "supertonic-service", type: "request", id, method, args})
      return domDispatcher.waitForResponse(id)
    }
  }
  domDispatcher.dispatch(event.data, sender, send)
})


//handle messages from extension service worker

const extDispatcher = makeDispatcher("supertonic-host", {
  async areYouThere({requestFocus}) {
    if (requestFocus) {
      const tab = await chrome.tabs.getCurrent()
      await Promise.all([
        chrome.windows.update(tab.windowId, {focused: true}),
        chrome.tabs.update(tab.id, {active: true})
      ])
    }
    return true
  },
  speak(args) {
    if (!supertonicService) throw new Error("No service")
    speechId = args.speechId
    return supertonicService.sendRequest("speak", args)
  },
  pause(args) {
    return supertonicService.sendRequest("pause", args)
  },
  resume(args) {
    return supertonicService.sendRequest("resume", args)
  },
  stop(args) {
    return supertonicService.sendRequest("stop", args)
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  return extDispatcher.dispatch(message, sender, res => {
    if (res.error instanceof Error || res.error instanceof DOMException) {
      res.error = {
        name: res.error.name,
        message: res.error.message,
        stack: res.error.stack
      }
    }
    sendResponse(res)
  })
})

function notifyServiceWorker(method, args) {
  chrome.runtime.sendMessage({
    to: "service-worker",
    type: "notification",
    method,
    args
  })
}
