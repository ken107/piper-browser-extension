import * as ort from 'onnxruntime-web'
import { SentencePieceTokenizer } from './sentencepiece'

// Pocket TTS inference over ONNX bundles made with export/ in this repo, or by KevinAHM
// (https://huggingface.co/KevinAHM/pocket-tts-onnx), whose export it was first written for.
// The pipeline mirrors his reference web worker at https://huggingface.co/spaces/KevinAHM/pocket-tts-web,
// minus streaming playback, which we don't use. Voices are cloned from reference clips, the way
// pocket-tts's get_state_for_audio_prompt does it; without its end_on_pause trimming, which the
// precomputed catalog voices for this model weren't made with.

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

//bundles from export/ in this repo add the fields after max_token_per_chunk, which KevinAHM's don't have;
//the defaults reproduce his reference web worker
interface BundleMetadata {
  sample_rate: number
  samples_per_frame: number
  latent_dim: number
  conditioning_dim: number
  max_token_per_chunk?: number
  flow_type?: 'lsd'|'drifting'
  default_temperature?: number
  default_eos_threshold?: number
  min_frames_before_eos?: number
  frames_after_eos_offset?: number
  replace_characters?: Record<string, string>
  tokenizer_file: string
  insert_bos_before_voice?: boolean
  bos_before_voice_file?: string
  remove_semicolons?: boolean
  pad_with_spaces_for_short_inputs?: boolean
  model_recommended_frames_after_eos?: number
  flow_lm_state_manifest: StateEntry[]
  mimi_state_manifest: StateEntry[]
}

type State = Record<string, ort.Tensor>

const TEMPERATURE = 0.7
const EOS_THRESHOLD = -4.0
const MAX_FRAMES = 500
const DECODE_FRAMES = 12
const CHUNK_GAP_SECONDS = 0.25
//a fresh decoder state starts with a small step, heard as a click, so fade in each chunk (as pocket-tts does)
const FADE_IN_SECONDS = 0.005
const MAX_CLIP_SECONDS = 30
//voice states hold the full KV cache (~50 MB each), so keep only the most recently used
const MAX_CACHED_VOICE_STATES = 2


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

  return new PocketTts(repoPath, sessionOptions, metadata, tokenizer, textConditioner, flowLmMain, flowLmFlow, mimiDecoder)
}


export class PocketTts {
  readonly sampleRate: number
  private voiceEncoder: Promise<{ mimiEncoder: ort.InferenceSession, bosBeforeVoice: ort.Tensor|null }>|undefined
  private readonly voiceEmbeddings = new Map<string, Promise<ort.Tensor>>()
  private readonly voiceStates = new Map<string, Promise<State>>()

  constructor(
    private readonly repoPath: string,
    private readonly sessionOptions: ort.InferenceSession.SessionOptions,
    private readonly metadata: BundleMetadata,
    private readonly tokenizer: SentencePieceTokenizer,
    private readonly textConditioner: ort.InferenceSession,
    private readonly flowLmMain: ort.InferenceSession,
    private readonly flowLmFlow: ort.InferenceSession,
    private readonly mimiDecoder: ort.InferenceSession
  ) {
    this.sampleRate = Number(metadata.sample_rate)
  }

  //encode a voice's reference clip (mono, at the model's sample rate) into its conditioning embedding
  addVoice(voiceId: string, clip: Float32Array) {
    const promise = this.encodeVoice(clip)
    promise.catch(() => this.voiceEmbeddings.delete(voiceId))
    this.voiceEmbeddings.set(voiceId, promise)
    this.voiceStates.delete(voiceId)
    return promise.then(() => {})
  }

  private async encodeVoice(clip: Float32Array) {
    this.voiceEncoder ??= Promise.all([
      ort.InferenceSession.create(`${this.repoPath}/mimi_encoder_int8.onnx`, this.sessionOptions),
      this.metadata.insert_bos_before_voice
        ? fetchBytes(`${this.repoPath}/${this.metadata.bos_before_voice_file || 'bos_before_voice.npy'}`).then(parseNpyFloat32)
        : null
    ]).then(([mimiEncoder, bosBeforeVoice]) => ({ mimiEncoder, bosBeforeVoice }))
    this.voiceEncoder.catch(() => this.voiceEncoder = undefined)
    const { mimiEncoder, bosBeforeVoice } = await this.voiceEncoder

    //the encoder takes whole frames, pad with silence as pocket-tts does
    const frameSize = Number(this.metadata.samples_per_frame)
    const audio = new Float32Array(Math.ceil(Math.min(clip.length, MAX_CLIP_SECONDS * this.sampleRate) / frameSize) * frameSize)
    audio.set(clip.subarray(0, audio.length))
    const result = await mimiEncoder.run({ audio: new ort.Tensor('float32', audio, [1, 1, audio.length]) })
    const encoded = result[mimiEncoder.outputNames[0]]
    const dim = encoded.dims[encoded.dims.length - 1]
    const frames = encoded.dims[encoded.dims.length - 2]
    const embedding = encoded.data as Float32Array
    if (!bosBeforeVoice) return new ort.Tensor('float32', embedding, [1, frames, dim])

    const bosFrames = bosBeforeVoice.dims[1]
    const combined = new Float32Array(bosBeforeVoice.data.length + embedding.length)
    combined.set(bosBeforeVoice.data as Float32Array)
    combined.set(embedding, bosBeforeVoice.data.length)
    return new ort.Tensor('float32', combined, [1, bosFrames + frames, dim])
  }

  //prompt the model with the voice embedding, the resulting KV cache is the voice's starting state
  private getVoiceState(voiceId: string) {
    let promise = this.voiceStates.get(voiceId)
    if (promise) {
      this.voiceStates.delete(voiceId)
    }
    else {
      const embedding = this.voiceEmbeddings.get(voiceId)
      if (!embedding) throw new Error(`Voice not added: ${voiceId}`)
      promise = embedding.then(async voiceEmb => {
        const state = initState(this.metadata.flow_lm_state_manifest)
        const emptySeq = new ort.Tensor('float32', new Float32Array(0), [1, 0, Number(this.metadata.latent_dim)])
        const result = await this.flowLmMain.run({ sequence: emptySeq, text_embeddings: voiceEmb, ...state })
        updateState(state, result, this.metadata.flow_lm_state_manifest)
        return state
      })
      promise.catch(() => this.voiceStates.delete(voiceId))
    }
    //re-insert as most recently used, evicting the oldest
    this.voiceStates.set(voiceId, promise)
    while (this.voiceStates.size > MAX_CACHED_VOICE_STATES) {
      this.voiceStates.delete(this.voiceStates.keys().next().value!)
    }
    return promise
  }

  async synthesize(text: string, voiceId: string, lsdSteps: number): Promise<Float32Array> {
    const baseFlowState = await this.getVoiceState(voiceId)
    const { chunks, framesAfterEos } = this.splitText(text)
    const latentDim = Number(this.metadata.latent_dim)
    const emptySeq = new ort.Tensor('float32', new Float32Array(0), [1, 0, latentDim])
    const emptyTextEmb = new ort.Tensor('float32', new Float32Array(0), [1, 0, Number(this.metadata.conditioning_dim)])
    const md = this.metadata
    const isDrifting = md.flow_type == 'drifting'
    const stTensors = makeFlowTimesteps(lsdSteps)
    const std = Math.sqrt(md.default_temperature ?? TEMPERATURE)
    const eosThreshold = md.default_eos_threshold ?? EOS_THRESHOLD
    const minFramesBeforeEos = md.min_frames_before_eos ?? 0
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
        if ((arResult.eos_logit.data as Float32Array)[0] > eosThreshold && eosStep == null && step >= minFramesBeforeEos) eosStep = step
        const shouldStop = eosStep != null && step >= eosStep + framesAfterEos

        let latent = new Float32Array(latentDim)
        for (let i = 0; i < latentDim; i++) latent[i] = gaussian() * std
        if (isDrifting) {
          //one-step head, maps the noise straight to the latent
          const flowResult = await this.flowLmFlow.run({ c: arResult.conditioning, x: new ort.Tensor('float32', latent, [1, latentDim]) })
          latent = new Float32Array(flowResult.latent.data as Float32Array)
        }
        else {
          //integrate the flow from noise to latent
          for (const {s, t} of stTensors) {
            const flowResult = await this.flowLmFlow.run({
              c: arResult.conditioning,
              s, t,
              x: new ort.Tensor('float32', latent, [1, latentDim])
            })
            const flowDir = flowResult.flow_dir.data as Float32Array
            for (let i = 0; i < latentDim; i++) latent[i] += flowDir[i] / lsdSteps
          }
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
          const audio = new Float32Array(decodeResult[this.mimiDecoder.outputNames[0]].data as Float32Array)
          if (decoded == 0) fadeIn(audio, Math.floor(FADE_IN_SECONDS * this.sampleRate))
          audioParts.push(audio)
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
    let prompt = text
    if (md.replace_characters) {
      //replace characters absent from the training data; a deleted quote can leave a sentence mark followed by a comma
      for (const [from, to] of Object.entries(md.replace_characters)) prompt = prompt.split(from).join(to)
      prompt = prompt.replace(/([.!?\u2026])\s*[,;:]/g, '$1')
    }
    prompt = prompt.replace(/\s+/g, ' ').trim()
    if (md.remove_semicolons) prompt = prompt.replace(/;/g, ',')

    const wordCount = prompt.split(' ').filter(Boolean).length
    const framesAfterEos = md.model_recommended_frames_after_eos != null
      ? Number(md.model_recommended_frames_after_eos)
      : (wordCount <= 4 ? 3 : 1) + (md.frames_after_eos_offset ?? 0)

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
        chunks.push(...this.splitLongSentence(sentence, maxTokens))
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

  //split an over-long sentence at clause boundaries, falling back to word boundaries,
  //so chunks (and the pauses between them) never fall mid-phrase
  private splitLongSentence(sentence: string, maxTokens: number) {
    const fits = (text: string) => this.tokenizer.encodeIds(text).length <= maxTokens
    const pack = (pieces: string[], splitPiece: (piece: string) => string[]) => {
      const result: string[] = []
      let current = ''
      for (const piece of pieces) {
        const combined = current ? `${current} ${piece}` : piece
        if (fits(combined)) {
          current = combined
        }
        else {
          if (current) result.push(current)
          current = ''
          if (fits(piece)) current = piece
          else result.push(...splitPiece(piece))
        }
      }
      if (current) result.push(current)
      return result
    }
    const clauses = (sentence.match(/[^,;:\u2013\u2014]+[,;:\u2013\u2014]*/g) ?? [sentence]).map(c => c.trim()).filter(Boolean)
    return pack(clauses, clause => pack(clause.split(' '), word => [word]))
  }

  dispose() {
    return Promise.allSettled([
      this.textConditioner.release(),
      this.flowLmMain.release(),
      this.flowLmFlow.release(),
      this.mimiDecoder.release(),
      this.voiceEncoder?.then(x => x.mimiEncoder.release()),
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

function fadeIn(audio: Float32Array, length: number) {
  const n = Math.min(length, audio.length)
  for (let i = 0; i < n; i++) audio[i] *= i / n
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


function parseNpyFloat32(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const view = new DataView(buffer)
  if (view.getUint8(0) != 0x93 || new TextDecoder().decode(new Uint8Array(buffer, 1, 5)) != 'NUMPY') throw new Error('Invalid NPY file')
  const major = view.getUint8(6)
  const headerLen = major == 1 ? view.getUint16(8, true) : view.getUint32(8, true)
  const headerOffset = major == 1 ? 10 : 12
  const header = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen))
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error('Unsupported NPY format')
  const shape = header.match(/'shape':\s*\(([^)]*)\)/)![1].split(',').map(x => x.trim()).filter(Boolean).map(Number)
  return new ort.Tensor('float32', new Float32Array(buffer, headerOffset + headerLen), shape)
}
