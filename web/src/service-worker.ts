/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;
export {};

import config from "./config";

//On app update, besides switching cache bucket, we need to force browser to get the latest versions
//from the network by also changing the query string of every resource
//Otherwise our new cache bucket might get populated with old files from the browser cache (or
//any intermediary network caches)

//3 caches, cache on fetch only, versioning:
//app cache: append ver to URL
//ort cache: ver already part of URL
//supertonic: no ver in URL

self.addEventListener('activate', (event: ExtendableEvent) =>
  event.waitUntil(
    Promise.all([
      removeOldCaches(),
      self.clients.claim()
    ])
  )
)

self.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.url.startsWith('http://localhost'))
    return;
  if (event.request.url.startsWith(self.location.origin))
    event.respondWith(handleFetch(event.request, config.appCacheKey))
  else if (event.request.url.startsWith(config.ortWasmPaths))
    event.respondWith(handleFetch(event.request, config.ortCacheKey))
  else if (event.request.url.startsWith(config.supertonicRepoPath))
    event.respondWith(handleFetch(event.request, config.supertonicCacheKey))
})


async function removeOldCaches() {
  for (const key of await caches.keys()) {
    if (![config.appCacheKey, config.ortCacheKey, config.supertonicCacheKey].includes(key))
      await caches.delete(key)
  }
}

async function handleFetch(request: Request, cacheKey: string) {
  const cachedResponse = await caches.match(request, { ignoreSearch: true })
  if (cachedResponse) return cachedResponse

  //append ver to app URLs
  if (cacheKey == config.appCacheKey) {
    request = new Request(
      request.url.split('?', 1)[0] + `?v=${config.appVer}`,
      new Proxy(request, {
        get: (target, prop) => prop == 'mode' ? undefined : Reflect.get(target, prop)
      }
    ))
  }

  const fetchResponse = await fetch(request)
  if (!fetchResponse.ok || !fetchResponse.body) return fetchResponse

  const cache = await caches.open(cacheKey)
  const [stream1, stream2] = fetchResponse.body.tee()
  const tracker = trackProgress(request.url, fetchResponse.headers.get('content-length'))
  cache.put(request, new Response(wrapStream(stream1, tracker), fetchResponse))
  return new Response(stream2, fetchResponse)
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
