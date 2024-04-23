
//On app update, besides switching cache bucket, we need to force browser to get the latest versions
//from the network by also changing the query string of every resource
//Otherwise our new cache bucket might get populated with old files from the browser cache (or
//any intermediary network caches)

const myCache = {
  'app-v11': [
    '/?v=11',
    '/index.html?v=11',
    '/bundle.js?v=11',
    '/inference-worker.js?v=11',
  ],
  'bootstrap-v1': [
    '/bootstrap.min.css?v=1',
  ],
  'wasm-v1': [
    '/ort-wasm-simd-threaded.wasm?v=1',
  ]
}

self.addEventListener('install', event => event.waitUntil(populateCache()))
self.addEventListener('activate', event => event.waitUntil(removeOldCaches()))
self.addEventListener('fetch', event => event.respondWith(handleFetch(event.request)))


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

async function handleFetch(request) {
  return await caches.match(request, {ignoreSearch: true}) || fetch(request)
}
