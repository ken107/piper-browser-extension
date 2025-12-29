# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome browser extension (Manifest v3) that provides Kokoro-82M text-to-speech voices as a native browser TTS engine. The project uses a split architecture:
- `extension/`: Browser extension components (service worker, extension host)
- `web/`: React-based web service that handles TTS synthesis

The extension communicates with a web service (hosted at piper.ttstool.com or localhost during dev) via iframe and postMessage, which in turn uses a Web Worker to run the Kokoro ONNX model for synthesis.

## Development Commands

### Web Service (React UI)
```bash
cd web
npm install          # Install dependencies
npm run dev          # Start development server (Vite)
npm run build        # Build for production (TypeScript check + Vite build)
npm run lint         # Run ESLint
npm run preview      # Preview production build
```

### Extension Packaging
```bash
cd extension
npm run package      # Create extension package (build/package.zip)
```

### Loading the Extension for Development
1. Build the web service: `cd web && npm run build`
2. Copy built assets from `web/dist/` to `extension/build/`
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode"
5. Click "Load unpacked" and select the `extension/` directory

## Architecture

### Three-Layer Communication Model

```
[Service Worker] ←→ [Extension Host] ←→ [Web Service iframe]
  (background)        (index.js)           (React App)
                                                ↓
                                        [Web Worker]
                                        (inference-worker.ts)
```

1. **Service Worker** (`extension/service-worker.js`)
   - Listens to `chrome.ttsEngine.onSpeak` events from the browser
   - Routes messages between browser TTS API and extension host
   - Manages TTS engine lifecycle (speak, pause, resume, stop)

2. **Extension Host** (`extension/index.js`)
   - Acts as a bridge between Service Worker and Web Service
   - Hosts an iframe pointing to the web service
   - Uses `postMessage` for cross-context communication
   - Advertises available voices using `chrome.ttsEngine.updateVoices()`

3. **Web Service** (`web/src/`)
   - React UI for model management and testing
   - Handles TTS synthesis requests via message dispatcher
   - Delegates heavy computation to Web Worker
   - Manages model loading, status, and audio playback

4. **Web Worker** (`web/src/inference-worker.ts`)
   - Runs Kokoro-82M ONNX model in isolated thread
   - Uses WebGPU backend (with WASM fallback)
   - Returns PCM audio data via transferable objects

### Message Passing Pattern

The codebase uses a custom message dispatcher (`@lsdsoftware/message-dispatcher`) for RPC-style communication across all layers. Messages follow a request/response pattern with notifications.

**Key dispatcher methods:**
- `dispatcher.dispatch(message, sender, sendResponse)` - Handle incoming messages
- `dispatcher.request(method, args)` - Send request and await response
- `dispatcher.notify(method, args)` - Send one-way notification

All components (Service Worker, Extension Host, Web Service, Web Worker) use this pattern consistently.

### TTS Synthesis Pipeline

1. **Text Splitting** ([web/src/speech.ts](web/src/speech.ts))
   - Splits text into sentences using language-aware regex
   - Handles 40+ languages (Hebrew, Arabic, East Asian, etc.)
   - Preserves character positions for progress tracking

2. **Sentence-by-Sentence Processing**
   - Synthesizes one sentence at a time
   - Prefetches ahead to maintain smooth playback
   - Supports pause/resume/seek controls

3. **Audio Playback** ([web/src/audio.ts](web/src/audio.ts))
   - Uses Web Audio API
   - Applies normalization, pitch, rate, volume adjustments
   - Adds silence between sentences (0.2s default, 0.75s for paragraphs)

### State Management

- **RxJS Observables**: Model status tracking using `BehaviorSubject`
  - `modelStatus$` in [web/src/synthesizer.ts](web/src/synthesizer.ts) broadcasts loading/ready state
  - Speech control uses RxJS operators (`scan`, `switchMap`) for pause/resume state machine

- **React State**: UI uses `use-immer` for immutable updates
  - Activity logs, model status display, voice selection

### Key Files

- [web/src/index.tsx](web/src/index.tsx) - Main React UI, message dispatcher setup, model management
- [web/src/inference-worker.ts](web/src/inference-worker.ts) - Web Worker that loads and runs Kokoro model
- [web/src/synthesizer.ts](web/src/synthesizer.ts) - Worker communication layer, model status observable
- [web/src/speech.ts](web/src/speech.ts) - Sentence splitting, synthesis orchestration, playback control
- [web/src/audio.ts](web/src/audio.ts) - Web Audio API wrapper for PCM playback
- [web/src/services.ts](web/src/services.ts) - Voice list and metadata
- [extension/service-worker.js](extension/service-worker.js) - Browser TTS engine integration
- [extension/index.js](extension/index.js) - Extension host and message router

### Voice System

Kokoro provides 40+ multilingual voices (e.g., `af_bella`, `en_male`, `ja_male`).
- Voice format: `"Kokoro {voiceId} ({language})"`
- Defined in [web/src/services.ts](web/src/services.ts)
- Advertised to Chrome via `chrome.ttsEngine.updateVoices()`

## Important Constraints

### CORS & Security Headers

The extension requires strict CORS policies to enable WebGPU:
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`

These are set in:
- [extension/manifest.json](extension/manifest.json) - For the extension
- [web/vite.config.ts](web/vite.config.ts) - For dev server

**Important**: Any external resources (WASM, models) must be served with `Cross-Origin-Resource-Policy: cross-origin` header. The project uses jsDelivr CDN for ONNX WASM files.

### Web Worker Requirements

The inference worker must be loaded as an ES module:
```typescript
new Worker(new URL("./inference-worker.ts", import.meta.url), {type: "module"})
```

### Model Loading

The Kokoro-82M ONNX model (~180MB) is loaded from HuggingFace:
- Model ID: `"onnx-community/Kokoro-82M-ONNX"`
- Device preference: `webgpu` → `wasm` (fallback)
- dtype: `fp32`
- Cached in browser storage after first download

## Lazy Initialization Pattern

The codebase uses a `lazy()` utility ([web/src/utils.ts](web/src/utils.ts)) for deferred initialization:
```typescript
const getAudioCtx = lazy(() => new AudioContext())
const getKokoro = lazy(() => KokoroTTS.from_pretrained(...))
```

This avoids creating expensive resources until first use and ensures singleton instances.

## Audio Processing Details

- **Sample Rate**: 24000 Hz (Kokoro output)
- **Channels**: 1 (mono)
- **Format**: Float32Array PCM
- **Normalization**: Applied based on peak amplitude to prevent clipping
- **Silence**: Concatenated between sentences using `concatenateFloat32Arrays()` with even-length padding (required for proper WAV playback)

## Browser Compatibility

- **Minimum Chrome Version**: Manifest v3 support (Chrome 88+)
- **WebGPU**: Optional but recommended for faster inference
- **WASM**: Fallback for browsers without WebGPU support
- **Service Worker**: Required for Manifest v3 background scripts
