import * as ort from 'onnxruntime-web'
import { SentencePieceTokenizer } from './sentencepiece'

// Pocket TTS inference over the ONNX export by KevinAHM (https://huggingface.co/KevinAHM/pocket-tts-onnx).
// The pipeline mirrors the reference web worker at https://huggingface.co/spaces/KevinAHM/pocket-tts-web,
// minus voice cloning (mimi_encoder) and streaming playback, which we don't use.

type DType = 'float32'|'int64'|'bool'

interface StateEntry {
  input_name: string
  output_name: string
  module?: string
  key?: string
  dtype: DType
  shape: number[]
  fill?: string
}

interface BundleMetadata {
  sample_rate: number
  samples_per_frame: number
  latent_dim: number
  conditioning_dim: number
  max_token_per_chunk?: number
  tokenizer_file: string
  predefined_voices?: string[]
  remove_semicolons?: boolean
  pad_with_spaces_for_short_inputs?: boolean
  model_recommended_frames_after_eos?: number
  flow_lm_state_manifest: StateEntry[]
  mimi_state_manifest: StateEntry[]
}

interface RawTensor {
  data: Float32Array|BigInt64Array|Uint8Array
  shape: number[]
  dtype: DType
}

type VoiceRecord = Record<string, RawTensor>
type State = Record<string, ort.Tensor>

const TEMPERATURE = 0.7
const EOS_THRESHOLD = -4.0
const MAX_FRAMES = 500
const DECODE_FRAMES = 12
const CHUNK_GAP_SECONDS = 0.25


export async function loadPocketTts(repoPath: string, sessionOptions: ort.InferenceSession.SessionOptions) {
  const res = await fetch(`${repoPath}/bundle.json`)
  if (!res.ok) throw new Error(`Failed to load bundle.json (${res.status})`)
  const metadata: BundleMetadata = await res.json()

  const [textConditioner, flowLmMain, flowLmFlow, mimiDecoder, tokenizer] = await Promise.all([
    ort.InferenceSession.create(`${repoPath}/text_conditioner_int8.onnx`, sessionOptions),
    ort.InferenceSession.create(`${repoPath}/flow_lm_main_int8.onnx`, sessionOptions),
    ort.InferenceSession.create(`${repoPath}/flow_lm_flow_int8.onnx`, sessionOptions),
    ort.InferenceSession.create(`${repoPath}/mimi_decoder_int8.onnx`, sessionOptions),
    fetchBytes(`${repoPath}/${metadata.tokenizer_file}`).then(bytes => new SentencePieceTokenizer(bytes)),
  ])

  return new PocketTts(repoPath, metadata, tokenizer, textConditioner, flowLmMain, flowLmFlow, mimiDecoder)
}


export class PocketTts {
  readonly sampleRate: number
  private voiceRecords: Promise<Record<string, VoiceRecord>>|undefined
  private readonly voiceStates = new Map<string, Promise<State>>()

  constructor(
    private readonly repoPath: string,
    private readonly metadata: BundleMetadata,
    private readonly tokenizer: SentencePieceTokenizer,
    private readonly textConditioner: ort.InferenceSession,
    private readonly flowLmMain: ort.InferenceSession,
    private readonly flowLmFlow: ort.InferenceSession,
    private readonly mimiDecoder: ort.InferenceSession
  ) {
    this.sampleRate = Number(metadata.sample_rate)
  }

  getVoiceState(voiceId: string) {
    let promise = this.voiceStates.get(voiceId)
    if (!promise) {
      if (!this.voiceRecords) {
        this.voiceRecords = fetchBytes(`${this.repoPath}/voices.bin`).then(bytes => parseVoicesBin(bytes.buffer as ArrayBuffer))
      }
      promise = this.voiceRecords.then(records => {
        const record = records[voiceId]
        if (!record) throw new Error(`Voice not found: ${voiceId}`)
        return stateFromVoiceRecord(record, this.metadata.flow_lm_state_manifest)
      })
      promise.catch(() => this.voiceStates.delete(voiceId))
      this.voiceStates.set(voiceId, promise)
    }
    return promise
  }

  async synthesize(text: string, voiceId: string, lsdSteps: number): Promise<Float32Array> {
    const baseFlowState = await this.getVoiceState(voiceId)
    const { chunks, framesAfterEos } = this.splitText(text)
    const latentDim = Number(this.metadata.latent_dim)
    const emptySeq = new ort.Tensor('float32', new Float32Array(0), [1, 0, latentDim])
    const emptyTextEmb = new ort.Tensor('float32', new Float32Array(0), [1, 0, Number(this.metadata.conditioning_dim)])
    const stTensors = makeFlowTimesteps(lsdSteps)
    const std = Math.sqrt(TEMPERATURE)
    const audioParts: Float32Array[] = []

    for (const chunkText of chunks) {
      if (audioParts.length) audioParts.push(new Float32Array(Math.floor(CHUNK_GAP_SECONDS * this.sampleRate)))

      const flowState: State = { ...baseFlowState }
      const mimiState = initState(this.metadata.mimi_state_manifest)

      //condition on the text
      const tokenIds = this.tokenizer.encodeIds(chunkText)
      const tokenTensor = new ort.Tensor('int64', BigInt64Array.from(tokenIds, BigInt), [1, tokenIds.length])
      let textEmb = (await this.textConditioner.run({ token_ids: tokenTensor }))[this.textConditioner.outputNames[0]]
      if (textEmb.dims.length == 2) {
        textEmb = new ort.Tensor('float32', textEmb.data as Float32Array, [1, textEmb.dims[0], textEmb.dims[1]])
      }
      const condResult = await this.flowLmMain.run({ sequence: emptySeq, text_embeddings: textEmb, ...flowState })
      updateState(flowState, condResult, this.metadata.flow_lm_state_manifest)

      //autoregressively generate latent frames until EOS
      const latents: Float32Array[] = []
      let decoded = 0
      let currentLatent = new ort.Tensor('float32', new Float32Array(latentDim).fill(NaN), [1, 1, latentDim])
      let eosStep: number|null = null

      for (let step = 0; step < MAX_FRAMES; step++) {
        const arResult = await this.flowLmMain.run({ sequence: currentLatent, text_embeddings: emptyTextEmb, ...flowState })
        if ((arResult.eos_logit.data as Float32Array)[0] > EOS_THRESHOLD && eosStep == null) eosStep = step
        const shouldStop = eosStep != null && step >= eosStep + framesAfterEos

        //integrate the flow from noise to latent
        const latent = new Float32Array(latentDim)
        for (let i = 0; i < latentDim; i++) latent[i] = gaussian() * std
        for (const {s, t} of stTensors) {
          const flowResult = await this.flowLmFlow.run({
            c: arResult.conditioning,
            s, t,
            x: new ort.Tensor('float32', latent, [1, latentDim])
          })
          const flowDir = flowResult.flow_dir.data as Float32Array
          for (let i = 0; i < latentDim; i++) latent[i] += flowDir[i] / lsdSteps
        }
        latents.push(latent)
        currentLatent = new ort.Tensor('float32', latent, [1, 1, latentDim])
        updateState(flowState, arResult, this.metadata.flow_lm_state_manifest)

        //decode to audio in batches, the decoder is stateful
        const pending = latents.length - decoded
        if (pending >= DECODE_FRAMES || (shouldStop && pending > 0)) {
          const batch = new Float32Array(pending * latentDim)
          for (let f = 0; f < pending; f++) batch.set(latents[decoded + f], f * latentDim)
          const decodeResult = await this.mimiDecoder.run({
            latent: new ort.Tensor('float32', batch, [1, pending, latentDim]),
            ...mimiState
          })
          updateState(mimiState, decodeResult, this.metadata.mimi_state_manifest)
          audioParts.push(new Float32Array(decodeResult[this.mimiDecoder.outputNames[0]].data as Float32Array))
          decoded += pending
        }
        if (shouldStop) break
      }
    }

    return concat(audioParts)
  }

  //normalize the text and split it into chunks that fit the model's token limit
  private splitText(text: string) {
    const md = this.metadata
    const maxTokens = Number(md.max_token_per_chunk || 50)
    let prompt = text.replace(/\s+/g, ' ').trim()
    if (md.remove_semicolons) prompt = prompt.replace(/;/g, ',')

    const wordCount = prompt.split(' ').filter(Boolean).length
    const framesAfterEos = md.model_recommended_frames_after_eos != null
      ? Number(md.model_recommended_frames_after_eos)
      : (wordCount <= 4 ? 3 : 1)

    if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) prompt = prompt[0].toUpperCase() + prompt.slice(1)
    if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) prompt += '.'
    if (md.pad_with_spaces_for_short_inputs && wordCount < 5) prompt = '        ' + prompt

    const chunks: string[] = []
    let current = ''
    for (const sentence of (prompt.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map(s => s.trim()).filter(Boolean)) {
      const ids = this.tokenizer.encodeIds(sentence)
      if (ids.length > maxTokens) {
        if (current) chunks.push(current)
        current = ''
        for (let i = 0; i < ids.length; i += maxTokens) {
          const piece = this.tokenizer.decodeIds(ids.slice(i, i + maxTokens)).trim()
          if (piece) chunks.push(piece)
        }
      }
      else if (!current) {
        current = sentence
      }
      else if (this.tokenizer.encodeIds(`${current} ${sentence}`).length > maxTokens) {
        chunks.push(current)
        current = sentence
      }
      else {
        current = `${current} ${sentence}`
      }
    }
    if (current) chunks.push(current)
    return { chunks, framesAfterEos }
  }

  dispose() {
    return Promise.allSettled([
      this.textConditioner.release(),
      this.flowLmMain.release(),
      this.flowLmFlow.release(),
      this.mimiDecoder.release(),
    ])
  }
}


async function fetchBytes(url: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

function makeFilled(dtype: DType, shape: number[], fill?: string) {
  const size = shape.reduce((a, b) => a * b, 1)
  if (dtype == 'int64') return new BigInt64Array(size)
  if (dtype == 'bool') return new Uint8Array(size)
  const data = new Float32Array(size)
  if (fill == 'nan') data.fill(NaN)
  else if (fill == 'ones') data.fill(1)
  return data
}

function makeTensor(dtype: DType, data: Float32Array|BigInt64Array|Uint8Array, shape: number[]) {
  return new ort.Tensor(dtype, data as any, shape)
}

function initState(manifest: StateEntry[]): State {
  const state: State = {}
  for (const entry of manifest) {
    state[entry.input_name] = makeTensor(entry.dtype, makeFilled(entry.dtype, entry.shape, entry.fill), entry.shape)
  }
  return state
}

function updateState(state: State, result: ort.InferenceSession.OnnxValueMapType, manifest: StateEntry[]) {
  for (const entry of manifest) {
    state[entry.input_name] = result[entry.output_name] as ort.Tensor
  }
}

function makeFlowTimesteps(lsdSteps: number) {
  const result = []
  for (let step = 0; step < lsdSteps; step++) {
    result.push({
      s: new ort.Tensor('float32', new Float32Array([step / lsdSteps]), [1, 1]),
      t: new ort.Tensor('float32', new Float32Array([(step + 1) / lsdSteps]), [1, 1]),
    })
  }
  return result
}

function gaussian() {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function concat(parts: Float32Array[]) {
  const result = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const p of parts) {
    result.set(p, offset)
    offset += p.length
  }
  return result
}


//voices.bin holds the precomputed FlowLM state of each built-in voice

function parseVoicesBin(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  const decoder = new TextDecoder()
  let offset = 0
  const readString = (len: number) => {
    const s = decoder.decode(new Uint8Array(buffer, offset, len))
    offset += len
    return s
  }

  if (readString(5) != 'PTVB1') throw new Error('Invalid voices.bin header')
  const voices: Record<string, VoiceRecord> = {}
  const voiceCount = view.getUint32(offset, true); offset += 4

  for (let v = 0; v < voiceCount; v++) {
    const name = readString(view.getUint16(offset, true) + (offset += 2, 0))
    const tensorCount = view.getUint16(offset, true); offset += 2
    const tensors: VoiceRecord = {}

    for (let t = 0; t < tensorCount; t++) {
      const key = readString(view.getUint16(offset, true) + (offset += 2, 0))
      const dtypeCode = view.getUint8(offset); offset += 1
      const rank = view.getUint8(offset); offset += 1
      const shape: number[] = []
      for (let d = 0; d < rank; d++) {
        shape.push(view.getUint32(offset, true)); offset += 4
      }
      const byteLength = view.getUint32(offset, true); offset += 4
      const bytes = buffer.slice(offset, offset + byteLength)
      offset += byteLength

      if (dtypeCode == 0) tensors[key] = { data: new Float32Array(bytes), shape, dtype: 'float32' }
      else if (dtypeCode == 1) tensors[key] = { data: new BigInt64Array(bytes), shape, dtype: 'int64' }
      else if (dtypeCode == 2) tensors[key] = { data: new Uint8Array(bytes), shape, dtype: 'bool' }
      else throw new Error(`Unsupported voices.bin dtype code: ${dtypeCode}`)
    }
    voices[name] = tensors
  }
  return voices
}

function stateFromVoiceRecord(record: VoiceRecord, manifest: StateEntry[]): State {
  //group tensors by module, keys are "module/key"
  const grouped: Record<string, Record<string, RawTensor>> = {}
  for (const [k, value] of Object.entries(record)) {
    const slash = k.indexOf('/')
    if (slash == -1) continue
    const mod = k.slice(0, slash)
    ;(grouped[mod] ??= {})[k.slice(slash + 1)] = value
  }

  const state = initState(manifest)
  for (const entry of manifest) {
    const moduleState = grouped[entry.module!] ?? {}
    const source = moduleState[entry.key!] ?? (entry.key == 'step' ? deriveStep(moduleState) : undefined)
    if (source) state[entry.input_name] = makeTensor(entry.dtype, adaptData(source, entry), entry.shape)
  }
  return state
}

function deriveStep(moduleState: Record<string, RawTensor>): RawTensor {
  const scalar = (n: bigint|number): RawTensor => ({ data: BigInt64Array.from([BigInt(n)]), shape: [1], dtype: 'int64' })
  if (moduleState.offset && !moduleState.end_offset) return scalar(moduleState.offset.data[0])
  if (moduleState.current_end) return scalar(moduleState.current_end.shape[0])
  return scalar(0)
}

//copy the stored tensor into the shape the model's state input expects, truncating or zero-padding each dimension
function adaptData(source: RawTensor, entry: StateEntry) {
  const targetShape = entry.shape
  const targetSize = targetShape.reduce((a, b) => a * b, 1)
  const convert = () => entry.dtype == 'int64' ? new BigInt64Array(source.data as BigInt64Array)
    : entry.dtype == 'bool' ? new Uint8Array(source.data as Uint8Array)
    : new Float32Array(source.data as Float32Array)

  if (source.data.length == targetSize) return convert()
  const target = makeFilled(entry.dtype, targetShape, entry.fill)
  if (source.shape.length != targetShape.length) return target

  const rank = source.shape.length
  const srcStrides = new Array<number>(rank)
  const dstStrides = new Array<number>(rank)
  for (let i = rank - 1, s = 1, d = 1; i >= 0; i--) {
    srcStrides[i] = s; s *= source.shape[i]
    dstStrides[i] = d; d *= targetShape[i]
  }
  const limits = source.shape.map((dim, i) => Math.min(dim, targetShape[i]))
  if (limits.some(x => x == 0)) return target

  const idx = new Array<number>(rank).fill(0)
  for (;;) {
    let si = 0, di = 0
    for (let i = 0; i < rank; i++) {
      si += idx[i] * srcStrides[i]
      di += idx[i] * dstStrides[i]
    }
    target[di] = source.data[si] as any
    let dim = rank - 1
    while (dim >= 0 && ++idx[dim] >= limits[dim]) idx[dim--] = 0
    if (dim < 0) return target
  }
}
