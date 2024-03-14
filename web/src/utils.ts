
export function immediate<T>(func: () => T) {
  return func()
}

export function lazy<T>(func: () => T) {
  let value: T
  return () => value ?? (value = func())
}

export async function* iterateStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      yield value
    }
  }
  finally {
    reader.releaseLock()
  }
}

export async function fetchWithProgress(url: string, callback: (percent: number) => void) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength === null) {
    throw new Error("Couldn't retrieve content-length");
  }
  if (!response.body) {
    throw new Error("No content")
  }

  const totalSize = parseInt(contentLength, 10);
  const chunks = [] as ArrayBuffer[]
  let loaded = 0;

  for await (const chunk of iterateStream(response.body)) {
    chunks.push(chunk)
    loaded += chunk.length;
    const progress = (loaded / totalSize) * 100;
    callback(progress);
  }

  return new Blob(chunks, {
    type: response.headers.get('content-type') || undefined
  })
}

export interface ExecutionSignal {
  resumed(): Promise<void>
  paused(): Promise<void>
}

export function makeExecutionControl() {
  let resume: () => void
  let resumePromise: Promise<void>|undefined
  let pause: () => void
  let pausePromise: Promise<void>|undefined = new Promise<void>(f => pause = f)
  let abort: (reason: unknown) => void
  const abortPromise = new Promise<never>((f, r) => abort = r)
  return {
    pause() {
      if (!resumePromise) resumePromise = new Promise<void>(f => resume = f)
      if (pausePromise) {
        pause()
        pausePromise = undefined
      }
    },
    resume() {
      if (!pausePromise) pausePromise = new Promise<void>(f => pause = f)
      if (resumePromise) {
        resume()
        resumePromise = undefined
      }
    },
    abort(reason: unknown) {
      abort(reason)
    },
    run<T>(asyncTask: (executionSignal: ExecutionSignal) => Promise<T>) {
      return Promise.race([
        abortPromise,
        asyncTask({
          resumed() {
            return Promise.race([abortPromise, resumePromise])
          },
          paused() {
            return Promise.race([abortPromise, pausePromise])
          }
        })
      ])
    }
  }
}
