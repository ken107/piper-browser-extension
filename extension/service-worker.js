
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: "http://localhost:8080/"
  })
})
