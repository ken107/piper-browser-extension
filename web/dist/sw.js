
const myCacheName = 'piper-v1'

self.addEventListener('install', event => event.waitUntil(populateCache()))
self.addEventListener('activate', event => event.waitUntil(removeOldCaches()))
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request)))


async function populateCache() {
  const cache = await caches.open(myCacheName)
  await cache.addAll([
    '/',
    '/index.html',
    '/bootstrap.min.css',
    '/bundle.js',
    '/ort-wasm-simd-threaded.wasm',
  ])
}

async function removeOldCaches() {
  for (const key of await caches.keys()) {
    if (key != myCacheName) await caches.delete(key)
  }
}
