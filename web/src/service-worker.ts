/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;
export {};

import config from "./config";

//On app update, besides switching cache bucket, we need to force browser to get the latest versions
//from the network by also changing the query string of every resource
//Otherwise our new cache bucket might get populated with old files from the browser cache (or
//any intermediary network caches)

//3 caches:
//-> app cache populated on install, file list from manifest, append ver
//-> ort cache populated on initial fetch, ver already part of URL
//-> supertonic cache managed by application

self.addEventListener('install', (event: ExtendableEvent) => event.waitUntil(populateCache()))
self.addEventListener('activate', (event: ExtendableEvent) => event.waitUntil(removeOldCaches()))
self.addEventListener('fetch', (event: FetchEvent) => event.respondWith(handleFetch(event.request)))


async function populateCache() {
  if (!await caches.has(config.appCacheKey)) {
    const response = await fetch('/asset-manifest.json')
    const manifest = await response.json()
    const appFiles = Object.values(manifest).concat('')
    const cache = await caches.open(config.appCacheKey)
    await cache.addAll(appFiles.map(file => `/${file}?v=${config.appVer}`))
  }
}

async function removeOldCaches() {
  for (const key of await caches.keys()) {
    if (![config.appCacheKey, config.ortCacheKey, config.supertonicCacheKey].includes(key))
      await caches.delete(key)
  }
}

async function handleFetch(request: Request) {
  //if localhost, use cache only for ort and supertonic assets, always fetch app assets
  if (location.hostname != 'localhost'
    || request.url.startsWith(config.ortWasmPaths)
    || request.url.startsWith(config.supertonicRepoPath)) {
    const cachedResponse = await caches.match(request, { ignoreSearch: true })
    if (cachedResponse) return cachedResponse
  }
  const fetchResponse = await fetch(request)
  //populate on initial fetch
  if (fetchResponse.ok && request.url.startsWith(config.ortWasmPaths)) {
    const clonedResponse = fetchResponse.clone()
    caches.open(config.ortCacheKey)
      .then(cache => cache.put(request, clonedResponse))
  }
  return fetchResponse
}
