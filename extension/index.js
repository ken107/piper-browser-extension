
let piperService


//handle messages from piper-service

const domDispatcher = makeDispatcher("piper-host", {
  advertiseVoices({voices}, sender) {
    chrome.ttsEngine.updateVoices(voices.map(voice => ({...voice, eventTypes: ["start", "sentence", "end", "error"]})))
    piperService = sender
    notifyServiceWorker("piperServiceReady")
  },
  onStart(args) {
    notifyServiceWorker("onEvent", {method: "onStart", args})
  },
  onSentence(args) {
    notifyServiceWorker("onEvent", {method: "onSentence", args})
  },
  onParagraph(args) {
    notifyServiceWorker("onEvent", {method: "onParagraph", args})
  },
  onEnd(args) {
    notifyServiceWorker("onEvent", {method: "onEnd", args})
  },
  onError(args) {
    notifyServiceWorker("onEvent", {method: "onError", args})
  }
})

window.addEventListener("message", event => {
  const send = message => event.source.postMessage(message, {targetOrigin: event.origin})
  const sender = {
    sendRequest(method, args) {
      const id = String(Math.random())
      send({to: "piper-service", type: "request", id, method, args})
      return domDispatcher.waitForResponse(id)
    }
  }
  domDispatcher.dispatch(event.data, sender, send)
})


//handle messages from extension service worker

const extDispatcher = makeDispatcher("piper-host", {
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
    if (!piperService) throw new Error("No service")
    return piperService.sendRequest("speak", args)
  },
  pause(args) {
    return piperService.sendRequest("pause", args)
  },
  resume(args) {
    return piperService.sendRequest("resume", args)
  },
  stop(args) {
    return piperService.sendRequest("stop", args)
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
