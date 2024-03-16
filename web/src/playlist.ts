import * as rxjs from "rxjs"
import { PlaybackCommand, PlaybackState } from "./types"

export interface PlaylistItem {
  seekIndex: number
  next(): PlaylistItem|null
  prev(): PlaylistItem|null
  play(playbackState: rxjs.Observable<PlaybackState>): Promise<void>
}


export function playPlaylist(
  first: PlaylistItem|null,
  control: rxjs.Observable<PlaybackCommand>,
  playbackState: rxjs.Observable<PlaybackState>
) {
  return new Promise<void>((fulfill, reject) => {
    const nextSubject = new rxjs.Subject<"next">()
    rxjs.merge(nextSubject, control)
      .pipe(
        rxjs.startWith("next" as const),
        rxjs.scan((current, cmd) => {
          if (current == null) return first
          switch (cmd) {
            case "next":
              return current.next()
            case "forward":
              for (let p = current.next(); p; p = p.next()) if (p.seekIndex == current.seekIndex + 1) return p
            case "rewind":
              for (let p = first; p; p = p.next()) if (p.seekIndex == current.seekIndex - 1) return p
          }
          return current
        }, null as PlaylistItem|null),
        rxjs.takeWhile(item => item != null),
        rxjs.distinctUntilChanged(),
        rxjs.switchMap(item => {
          const abortSubject = new rxjs.Subject<never>()
          const endPromise = item!.play(rxjs.merge(abortSubject, playbackState))
          return rxjs.from(endPromise)
            .pipe(
              rxjs.finalize(() => abortSubject.error({name: "interrupted", message: "Playback interrupted"}))
            )
        })
      )
      .subscribe({
        next: () => nextSubject.next("next"),
        complete: fulfill,
        error: reject
      })
  })
}
