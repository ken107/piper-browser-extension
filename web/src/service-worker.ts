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
//pocket: no ver in URL, also holds the voices' reference clips

self.addEventListener('activate', (event: ExtendableEvent) =>
  event.waitUntil(
    Promise.all([
      removeOldCaches(),
      self.clients.claim()
    ])
  )
);

//pages that bypassed the SW (hard reload) ask to be claimed
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type == 'claim') event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = event.request.url;

  if (url.startsWith('http://localhost')) return;

  if (url.startsWith(self.registration.scope + 'voices.json')) {
    event.respondWith(networkFirst(event.request, config.appCacheKey));
  } else if (url.startsWith(self.location.origin)) {
    event.respondWith(handleFetch(event, config.appCacheKey));
  } else if (url.startsWith(config.ortWasmPaths)) {
    event.respondWith(handleFetch(event, config.ortCacheKey));
  } else if (url.startsWith(config.pocketRepoPath) || url.startsWith(config.voicesRepoPath)) {
    event.respondWith(handleFetch(event, config.pocketCacheKey));
  }
});

async function removeOldCaches() {
  const allowed = [config.appCacheKey, config.ortCacheKey, config.pocketCacheKey];
  const keys = await caches.keys();
  await Promise.all(
    keys.map(key => {
      if (!allowed.includes(key)) return caches.delete(key);
    })
  );
}

//the voice list is edited without an app version bump, so prefer the network, falling back to the cache offline
async function networkFirst(request: Request, cacheKey: string) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) {
      const cache = await caches.open(cacheKey);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cachedResponse = await caches.match(request, { ignoreSearch: true });
    if (cachedResponse) return cachedResponse;
    throw err;
  }
}

async function handleFetch(event: FetchEvent, cacheKey: string) {
  const originalRequest = event.request;

  // 1. Check Cache (ignoring search params helps hit cache even if versions change)
  const cachedResponse = await caches.match(originalRequest, { ignoreSearch: true });
  if (cachedResponse) return cachedResponse;

  let requestToFetch = originalRequest;

  // 2. Prepare Network Request
  if (cacheKey === config.appCacheKey) {
    const urlObj = new URL(originalRequest.url);
    // Safer: Update 'v' param, preserve others (unless you specifically want to wipe them)
    urlObj.searchParams.set('v', config.appVer);

    // Safer: Create a clean Request object instead of using Proxy
    requestToFetch = new Request(urlObj.toString(), {
      method: originalRequest.method,
      headers: originalRequest.headers,
      mode: 'cors', // Explicitly set mode to avoid 'navigate' issues if that was the intent
      credentials: originalRequest.credentials,
      redirect: originalRequest.redirect,
      referrer: originalRequest.referrer,
    });
  }

  // 3. Network Call
  const fetchResponse = await fetch(requestToFetch);
  if (!fetchResponse.ok || !fetchResponse.body) return fetchResponse;

  // 4. Clone and Cache
  const cache = await caches.open(cacheKey);
  const [streamForCache, streamForBrowser] = fetchResponse.body.tee();

  // Create throttled tracker
  const tracker = trackProgress(originalRequest.url, fetchResponse.headers.get('content-length'));

  // Wrap the cache stream
  const responseToCache = new Response(wrapStream(streamForCache, tracker), {
    headers: fetchResponse.headers, // Copy headers
    status: fetchResponse.status,
    statusText: fetchResponse.statusText
  });

  // Perform cache put effectively in the "background" relative to the browser response
  // catch() allows the app to continue even if caching fails (e.g. QuotaExceeded)
  event.waitUntil(
    cache.put(requestToFetch, responseToCache)
      .catch(err => console.warn('Cache put failed', err))
  );

  return new Response(streamForBrowser, fetchResponse);
}

function trackProgress(url: string, contentLength: string | null) {
  const total = contentLength ? Number(contentLength) : 0;
  let loaded = 0;
  let lastUpdate = 0;

  return (chunk: { byteLength: number }) => {
    loaded += chunk.byteLength;
    const now = Date.now();

    // THROTTLE: Only update clients every 200ms or if complete
    // This prevents flooding the JS main thread with postMessages
    if (now - lastUpdate > 100 || (total > 0 && loaded === total)) {
      lastUpdate = now;

      // Note: matchAll is async. We don't await it here to avoid blocking the stream
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'fetch-progress',
            url,
            loaded,
            total
          });
        });
      });
    }
  };
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
          // Pass value to tracker
          onChunk(value);
          // Pass value to stream
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
