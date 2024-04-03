import * as rxjs from "rxjs";

export function immediate<T>(func: () => T) {
  return func();
}

export function lazy<T>(func: () => T) {
  let value: T;
  return () => value ?? (value = func());
}

export async function* iterateStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function fetchWithProgress(
  url: string,
  callback: (percent: number) => void
): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      "Network response for request to '" +
        url +
        "'was not ok. Response: " +
        response.status +
        ", " +
        response.statusText
    );
  }
  if (!response.body) {
    throw new Error("No content. Body was: " + response.body);
  }

  const transferEncoding = response.headers.get("transfer-encoding");
  const contentLength = response.headers.get("content-length");

  if (!transferEncoding && contentLength === null) {
    throw new Error(
      "Couldn't retrieve content-length. Header 'content-length' not found.\nHeaders: " +
        [...response.headers.entries()]
          .map(([k, v]) => `\t${k}: ${v}`)
          .join(",\n")
    );
  }

  const chunks = [] as Uint8Array[];
  let loaded = 0;
  let totalSize = contentLength ? parseInt(contentLength, 10) : null;
  const reader = response.body.getReader();
  let read = await reader.read();

  while (!read.done) {
    const chunk = read.value;
    chunks.push(chunk);
    loaded += chunk.length;

    // If totalSize is known, calculate progress
    if (totalSize !== null) {
      const progress = (loaded / totalSize) * 100;
      callback(progress);
    } else {
      // If totalSize is unknown, notify of progress or loaded bytes
      callback(loaded);
    }

    // Read the next chunk
    read = await reader.read();
  }

  return new Blob(chunks, {
    type: response.headers.get("content-type") || undefined,
  });
}

export function wait<T>(obs: rxjs.Observable<T>, value: T) {
  return rxjs.firstValueFrom(obs.pipe(rxjs.filter((x) => x == value)));
}

export function makeExposedPromise<T>() {
  const exposed = {} as {
    promise: Promise<T>;
    fulfill(value: T): void;
    reject(reason: unknown): void;
  };
  exposed.promise = new Promise((fulfill, reject) => {
    exposed.fulfill = fulfill;
    exposed.reject = reject;
  });
  return exposed;
}

export function makeBatchProcessor<T, V>(
  maxBatchSize: number,
  process: (items: T[]) => Promise<V[]>
) {
  function makeBatch() {
    const items: T[] = [];
    return {
      items,
      size: 0,
      process: lazy(() => process(items)),
    };
  }
  let currentBatch: ReturnType<typeof makeBatch> | undefined;
  return {
    add(item: T, itemSize: number): () => Promise<V> {
      const batch =
        currentBatch && currentBatch.size + itemSize <= maxBatchSize
          ? currentBatch
          : (currentBatch = makeBatch());
      const index = batch.items.length;
      batch.items.push(item);
      batch.size += itemSize;
      return () => batch.process().then((results) => results[index]);
    },
  };
}
