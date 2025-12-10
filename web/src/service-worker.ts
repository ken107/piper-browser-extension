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
//-> supertonic voice styles cached on install, rest on initial fetch, no ver in URL

self.addEventListener('install', (event: ExtendableEvent) => event.waitUntil(populateCache()))
self.addEventListener('activate', (event: ExtendableEvent) => event.waitUntil(removeOldCaches()))
self.addEventListener('fetch', (event: FetchEvent) => event.respondWith(handleFetch(event.request)))


async function populateCache() {
  if (!await caches.has(config.appCacheKey)) {
    const manifest = await fetch('/asset-manifest.json').then(r => r.json())
    const appFiles = Object.values(manifest).concat('')
    const cache = await caches.open(config.appCacheKey)
    await cache.addAll(appFiles.map(file => `/${file}?v=${config.appVer}`))
  }
  if (!await caches.has(config.supertonicCacheKey)) {
    const cache = await caches.open(config.supertonicCacheKey)
    await cache.addAll(config.voiceList.map(voice => voice.stylePath))
  }
}

async function removeOldCaches() {
  for (const key of await caches.keys()) {
    if (![config.appCacheKey, config.ortCacheKey, config.supertonicCacheKey].includes(key))
      await caches.delete(key)
  }
}

async function handleFetch(request: Request) {
  const isProd = location.hostname != 'localhost'
  const isOrt = request.url.startsWith(config.ortWasmPaths)
  const isSupertonic = request.url.startsWith(config.supertonicRepoPath)

  if (isProd || isOrt || isSupertonic) {
    const cachedResponse = await caches.match(request, { ignoreSearch: true })
    if (cachedResponse) return cachedResponse
  }

  const fetchResponse = await fetch(request)
  if (fetchResponse.ok && fetchResponse.body && (isOrt || isSupertonic)) {
    const cache = await caches.open(isOrt ? config.ortCacheKey : config.supertonicCacheKey)
    const [stream1, stream2] = fetchResponse.body.tee()
    const tracker = trackProgress(request.url, fetchResponse.headers.get('content-length'))
    cache.put(request, new Response(wrapStream(stream1, tracker), fetchResponse))
    return new Response(stream2, fetchResponse)
  }
  else {
    return fetchResponse
  }
}

function trackProgress(url: string, contentLength: string|null) {
  const total = contentLength ? Number(contentLength) : null
  let loaded = 0
  return (chunk: { byteLength: number }) => {
    loaded += chunk.byteLength
    self.clients.matchAll().then(clients =>
      clients.forEach(client =>
        client.postMessage({ type: 'fetch-progress', url, loaded, total })
      )
    ).catch(() => {})
  }
}

function wrapStream<T>(sourceStream: ReadableStream<T>, onChunk: (chunk: T) => void) {
  const reader = sourceStream.getReader();
  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            break;
          }
          onChunk(value);
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    }
  });
}
