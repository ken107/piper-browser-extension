
let piperService


//handle messages from piper-service

const domDispatcher = makeDispatcher("piper-host", {
  advertiseVoices({voices}, sender) {
    chrome.ttsEngine.updateVoices(voices)
    piperService = sender
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
  speak(args) {
    if (!piperService) throw new Error("No service")
    return piperService.sendRequest("speak", args)
  },
  wait(args) {
    return piperService.sendRequest("wait", args)
  },
  pause() {
    return piperService.sendRequest("pause")
  },
  resume() {
    return piperService.sendRequest("resume")
  },
  stop() {
    return piperService.sendRequest("stop")
  }
})

chrome.runtime.onMessage.addListener(extDispatcher.dispatch)
