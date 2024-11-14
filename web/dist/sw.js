
//On app update, besides switching cache bucket, we need to force browser to get the latest versions
//from the network by also changing the query string of every resource
//Otherwise our new cache bucket might get populated with old files from the browser cache (or
//any intermediary network caches)

const myCache = {
  'app-v14': [
    '/?v=14',
    '/index.html?v=14',
    '/bundle.js?v=14',
    '/inference-worker.js?v=14',
  ],
  'bootstrap-v1': [
    '/bootstrap.min.css?v=1',
  ],
  'ort-1.17.3': [
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-simd-threaded.wasm',
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
