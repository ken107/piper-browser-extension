/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;
export {};

import config from "./config";

//On app update, besides switching cache bucket, we need to force browser to get the latest versions
//from the network by also changing the query string of every resource
//Otherwise our new cache bucket might get populated with old files from the browser cache (or
//any intermediary network caches)

const myCache: Record<string, string[]> = {
  'app-v2': [
    '/?v=2',
    '/index.html?v=2',
    '/bundle.js?v=2',
    '/inference-worker.js?v=2',
  ],
  'bootstrap-v1': [
    '/bootstrap.min.css?v=1',
  ],
}

//populated on initial fetch
myCache[config.ortCacheKey] = []

//managed by application
myCache[config.supertonicCacheKey] = []


self.addEventListener('install', (event: ExtendableEvent) => event.waitUntil(populateCache()))
self.addEventListener('activate', (event: ExtendableEvent) => event.waitUntil(removeOldCaches()))
self.addEventListener('fetch', (event: FetchEvent) => event.respondWith(handleFetch(event.request)))


async function populateCache() {
  for (const key in myCache) {
    if (!await caches.has(key)) {
      const cache = await caches.open(key)
      await cache.addAll(myCache[key])
    }
  }
}

async function removeOldCaches() {
  for (const key of await caches.keys()) {
    if (!(key in myCache)) await caches.delete(key)
  }
}

async function handleFetch(request: Request) {
  //if localhost, use the cache only for ort and supertonic assets
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
