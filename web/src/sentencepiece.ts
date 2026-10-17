// Minimal pure-JS SentencePiece Unigram tokenizer with byte fallback.
// Adapted from pocket-tts-js (https://github.com/vlapky/pocket-tts-js), MIT License, Copyright (c) 2026 vlapky
//
// Pocket TTS ships a `tokenizer.model` that is a Unigram model with byte_fallback
// and an identity normalizer, so we only need to escape spaces as U+2581, prepend
// a dummy prefix, run Viterbi over the vocabulary scores, and fall back to <0xXX>
// byte pieces for anything not in the vocab.

const SPACE = "▁"
const UNK_PENALTY = 10.0
const BYTE_RE = /^<0x([0-9A-Fa-f]{2})>$/

const utf8Decoder = new TextDecoder("utf-8", { fatal: false })
const utf8Encoder = new TextEncoder()

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let shift = 0
  let result = 0
  let i = pos
  for (;;) {
    const b = bytes[i++]
    result += (b & 0x7f) * Math.pow(2, shift)
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [result, i]
}

//parse the SentencePiece ModelProto `pieces` (field 1), each holding a piece string (field 1) and a float score (field 2)
function parseModelProto(bytes: Uint8Array) {
  const pieces: Array<{piece: Uint8Array, score: number}> = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let i = 0

  while (i < bytes.length) {
    let tag: number
    [tag, i] = readVarint(bytes, i)
    const field = tag >>> 3
    const wire = tag & 7

    if (wire === 2) {
      let len: number
      [len, i] = readVarint(bytes, i)
      const end = i + len
      if (field === 1) {
        let j = i
        let piece: Uint8Array = new Uint8Array(0)
        let score = 0
        while (j < end) {
          let ptag: number
          [ptag, j] = readVarint(bytes, j)
          const pf = ptag >>> 3
          const pw = ptag & 7
          if (pw === 2) {
            let plen: number
            [plen, j] = readVarint(bytes, j)
            if (pf === 1) piece = bytes.subarray(j, j + plen)
            j += plen
          }
          else if (pw === 5) {
            if (pf === 2) score = view.getFloat32(j, true)
            j += 4
          }
          else if (pw === 1) j += 8
          else if (pw === 0) [, j] = readVarint(bytes, j)
        }
        pieces.push({ piece, score })
      }
      i = end
    }
    else if (wire === 0) [, i] = readVarint(bytes, i)
    else if (wire === 5) i += 4
    else if (wire === 1) i += 8
  }
  return pieces
}

export class SentencePieceTokenizer {
  private readonly pieceToId = new Map<string, number>()
  private readonly idToPiece: string[] = []
  private readonly scores: number[] = []
  private readonly byteTokenId = new Int32Array(256).fill(-1)
  private minScore = 0
  private maxPieceChars = 1

  constructor(modelBytes: Uint8Array) {
    const pieces = parseModelProto(modelBytes)
    for (let id = 0; id < pieces.length; id++) {
      const { piece, score } = pieces[id]
      const text = utf8Decoder.decode(piece)
      this.idToPiece.push(text)
      this.scores.push(score)
      this.pieceToId.set(text, id)
      if (score < this.minScore) this.minScore = score
      const m = BYTE_RE.exec(text)
      if (m) this.byteTokenId[parseInt(m[1], 16)] = id
      const codepoints = Array.from(text).length
      if (codepoints > this.maxPieceChars) this.maxPieceChars = codepoints
    }
  }

  encodeIds(text: string): number[] {
    if (!text) return []
    const chars = Array.from(SPACE + text.replace(/ /g, SPACE))
    const n = chars.length
    const unkScore = this.minScore - UNK_PENALTY

    const best = new Float64Array(n + 1).fill(-Infinity)
    const backId = new Int32Array(n + 1).fill(-1)    //piece id, or -1 = byte fallback
    const backStart = new Int32Array(n + 1).fill(-1)
    best[0] = 0

    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue
      const maxLen = Math.min(this.maxPieceChars, n - i)
      let acc = ""
      for (let len = 1; len <= maxLen; len++) {
        acc += chars[i + len - 1]
        const id = this.pieceToId.get(acc)
        if (id === undefined) continue
        const score = best[i] + this.scores[id]
        if (score > best[i + len]) {
          best[i + len] = score
          backId[i + len] = id
          backStart[i + len] = i
        }
      }
      //single-char unknown step keeps the lattice connected
      const uScore = best[i] + unkScore
      if (uScore > best[i + 1]) {
        best[i + 1] = uScore
        backId[i + 1] = -1
        backStart[i + 1] = i
      }
    }

    const segments: Array<{id: number, start: number, end: number}> = []
    for (let pos = n; pos > 0; pos = backStart[pos]) {
      segments.push({ id: backId[pos], start: backStart[pos], end: pos })
    }
    segments.reverse()

    const ids: number[] = []
    for (const seg of segments) {
      if (seg.id >= 0) {
        ids.push(seg.id)
      }
      else {
        for (const b of utf8Encoder.encode(chars.slice(seg.start, seg.end).join(""))) {
          const bid = this.byteTokenId[b]
          if (bid >= 0) ids.push(bid)
        }
      }
    }
    return ids
  }

  decodeIds(ids: number[]): string {
    const out: number[] = []
    for (const id of ids) {
      const piece = this.idToPiece[id]
      if (piece === undefined) continue
      const m = BYTE_RE.exec(piece)
      if (m) out.push(parseInt(m[1], 16))
      else out.push(...utf8Encoder.encode(piece))
    }
    const text = utf8Decoder.decode(new Uint8Array(out)).split(SPACE).join(" ")
    return text.startsWith(" ") ? text.slice(1) : text
  }
}
