import * as rxjs from "rxjs"
import { PlaybackCommand, PlaybackState } from "./types"

export function makeSpeech() {
  const id = String(Math.random())
  const control = new rxjs.Subject<PlaybackCommand>()
  const playbackState = control
    .pipe(
      rxjs.scan((state: PlaybackState, cmd) => {
        if (cmd == "stop") throw {name: "interrupted", message: "Playback interrupted"}
        if (state == "resumed" && cmd == "pause") return "paused"
        if (state == "paused" && cmd == "resume") return "resumed"
        return state
      }, "resumed"),
      rxjs.startWith("resumed" as const),
      rxjs.distinctUntilChanged(),
      rxjs.shareReplay({bufferSize: 1, refCount: false})
    )

  return {
    id,
    control,

  }
}
