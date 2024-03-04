
const myCache = {
  'app-v1': [
    '/',
    '/index.html',
    '/bundle.js',
  ],
  'bootstrap-v1': [
    '/bootstrap.min.css',
  ],
  'wasm-v1': [
    '/ort-wasm-simd-threaded.wasm',
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
  return await caches.match(request) || fetch(request)
}
