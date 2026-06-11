// Documento offscreen: recibe el streamId de tabCapture, captura el audio de
// la pestaña, lo trocea en fragmentos con detección de pausas y los pasa por
// Whisper (transformers.js) y por el traductor (Translator API de Chrome si
// está disponible, o MarianMT/NLLB locales como en subvid.app).

import {
  ASR_MODELS,
  LANGS,
  MARIAN_TRANSLATION_MODELS,
  NLLB_MODEL,
} from "../shared/languages.ts"
import type { Settings, StatusPhase } from "../shared/types.ts"

const TARGET_SR = 16_000
const MAX_CHUNK_SECONDS = 7
const MIN_CHUNK_SECONDS = 2
const SILENCE_HOLD_SECONDS = 0.65
const SILENCE_RMS = 0.006
const MAX_PENDING_CHUNKS = 2

// ---------------------------------------------------------------------------
// Cliente de workers (versión reducida de src/scripts/transformersClient.ts)
// ---------------------------------------------------------------------------

type WorkerClient = {
  call: (type: string, payload?: unknown, transfer?: Transferable[]) => Promise<any>
  terminate: () => void
}

function createWorkerClient(
  worker: Worker,
  onProgress: (key: string, payload: any) => void,
): WorkerClient {
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: unknown) => void }
  >()
  let reqId = 0

  worker.onmessage = (event) => {
    const { id, type } = event.data || {}
    if (type === "progress") {
      onProgress(event.data.key, event.data.payload)
      return
    }
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (type === "error") request.reject(new Error(event.data.error))
    else request.resolve(event.data.result)
  }
  worker.onerror = (event) => {
    const reason = event.error || new Error(event.message)
    for (const [id, request] of pending) {
      pending.delete(id)
      request.reject(reason)
    }
  }

  return {
    call(type, payload, transfer = []) {
      const id = ++reqId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          worker.postMessage({ id, type, payload }, transfer)
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    terminate() {
      worker.terminate()
    },
  }
}

// ---------------------------------------------------------------------------
// Mensajería con el service worker
// ---------------------------------------------------------------------------

function toBackground(message: Record<string, unknown>) {
  chrome.runtime
    .sendMessage({ target: "background", ...message })
    .catch(() => undefined)
}

function postStatus(phase: StatusPhase, detail?: string, progress?: number) {
  toBackground({ type: "status", phase, detail, progress })
}

function postCue(original: string, translated: string | null, seconds: number) {
  toBackground({ type: "cue", original, translated, seconds })
}

// ---------------------------------------------------------------------------
// Estado de la sesión
// ---------------------------------------------------------------------------

let running = false
let settings: Settings | null = null

let media: MediaStream | null = null
let audioCtx: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null

let asrClient: WorkerClient | null = null
let translationClient: WorkerClient | null = null
let translationWorkerOpts: { src?: string; tgt?: string } | null = null
let builtinTranslator: any = null
let modelsReady: Promise<void> | null = null

const hasWebGPU = "gpu" in navigator

// ---------------------------------------------------------------------------
// Captura + troceado de audio
// ---------------------------------------------------------------------------

let pcmParts: Float32Array[] = []
let pcmLength = 0
let trailingSilence = 0
let chunkHasVoice = false

// Estado del remuestreador lineal (sampleRate del contexto → 16 kHz)
let resamplePos = 0
let resamplePrev = 0

function resetChunk() {
  pcmParts = []
  pcmLength = 0
  trailingSilence = 0
  chunkHasVoice = false
}

function downsample(block: Float32Array, ratio: number): Float32Array {
  const out: number[] = []
  let pos = resamplePos
  while (pos < block.length) {
    const i = Math.floor(pos)
    const frac = pos - i
    const s0 = i < 0 ? resamplePrev : block[i]
    const s1 = i + 1 < block.length ? block[i + 1] : block[block.length - 1]
    out.push(s0 + (s1 - s0) * frac)
    pos += ratio
  }
  resamplePos = pos - block.length
  resamplePrev = block[block.length - 1]
  return Float32Array.from(out)
}

function rmsOf(block: Float32Array) {
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
  return Math.sqrt(sum / Math.max(1, block.length))
}

function handleAudioBlock(block: Float32Array, sampleRate: number) {
  if (!running) return

  const blockSeconds = block.length / sampleRate
  const rms = rmsOf(block)
  if (rms < SILENCE_RMS) {
    trailingSilence += blockSeconds
  } else {
    trailingSilence = 0
    chunkHasVoice = true
  }

  const resampled = downsample(block, sampleRate / TARGET_SR)
  if (resampled.length) {
    pcmParts.push(resampled)
    pcmLength += resampled.length
  }

  const seconds = pcmLength / TARGET_SR
  const naturalPause =
    chunkHasVoice &&
    seconds >= MIN_CHUNK_SECONDS &&
    trailingSilence >= SILENCE_HOLD_SECONDS

  if (seconds >= MAX_CHUNK_SECONDS || naturalPause) {
    flushChunk()
  }
}

function flushChunk() {
  if (!chunkHasVoice) {
    // Silencio puro: lo descartamos para no alucinar texto.
    resetChunk()
    return
  }
  const chunk = new Float32Array(pcmLength)
  let offset = 0
  for (const part of pcmParts) {
    chunk.set(part, offset)
    offset += part.length
  }
  resetChunk()
  void enqueueChunk(chunk)
}

// ---------------------------------------------------------------------------
// Cola de procesamiento (transcribir + traducir)
// ---------------------------------------------------------------------------

const pendingChunks: Float32Array[] = []
let processing = false
let lastCueText = ""

async function enqueueChunk(chunk: Float32Array) {
  pendingChunks.push(chunk)
  // Si vamos atrasados, descartamos lo más antiguo para seguir "en vivo".
  while (pendingChunks.length > MAX_PENDING_CHUNKS) pendingChunks.shift()

  if (processing) return
  processing = true
  try {
    while (running && pendingChunks.length) {
      const next = pendingChunks.shift()!
      try {
        await processChunk(next)
      } catch (error) {
        console.error("[subvid:offscreen] chunk failed", error)
      }
    }
  } finally {
    processing = false
  }
}

function cleanTranscript(text: string) {
  const trimmed = text.trim()
  // Whisper alucina puntuación/música en fragmentos casi mudos.
  if (!trimmed || /^[\s.\-–—♪♫\[\]()]*$/.test(trimmed)) return ""
  return trimmed
}

async function processChunk(chunk: Float32Array) {
  if (!modelsReady || !asrClient || !settings) return
  await modelsReady
  if (!running) return

  const seconds = chunk.length / TARGET_SR
  const output = await asrClient.call(
    "transcribe",
    {
      audio: chunk,
      language: settings.sourceLang === "auto" ? null : settings.sourceLang,
    },
    [chunk.buffer],
  )

  const original = cleanTranscript(String(output?.text ?? ""))
  if (!original || original === lastCueText) return
  lastCueText = original

  let translated: string | null = null
  if (needsTranslation(settings)) {
    try {
      translated = await translateText(original)
    } catch (error) {
      console.warn("[subvid:offscreen] translation failed", error)
    }
  }

  if (!running) return
  postCue(original, translated, seconds)
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

function needsTranslation(s: Settings) {
  return s.targetLang !== "none" && s.targetLang !== s.sourceLang
}

function onWorkerProgress(key: string, payload: any) {
  if (payload?.status !== "progress") return
  const pct = typeof payload.progress === "number" ? payload.progress / 100 : 0
  const label =
    key === "asr" ? "Descargando modelo de voz" : "Descargando traductor"
  postStatus("downloading", label, Math.min(1, Math.max(0, pct)))
}

function createAsrWorker() {
  return createWorkerClient(
    new Worker(new URL("./asr.worker.ts", import.meta.url), {
      type: "module",
    }),
    onWorkerProgress,
  )
}

async function ensureAsr(s: Settings) {
  if (!asrClient) asrClient = createAsrWorker()
  const model = ASR_MODELS[s.model] || ASR_MODELS.tiny
  try {
    await asrClient.call("ensure-asr", { model, webgpu: hasWebGPU })
  } catch (error) {
    if (!hasWebGPU) throw error
    console.warn("[subvid:offscreen] WebGPU falló, reintentando en WASM", error)
    // Una sesión ONNX fallida puede dejar el runtime del worker en mal estado
    // (init chain envenenada): recreamos el worker antes de reintentar.
    asrClient.terminate()
    asrClient = createAsrWorker()
    await asrClient.call("ensure-asr", { model, webgpu: false })
  }
}

async function tryBuiltinTranslator(src: string, tgt: string) {
  const Translator = (self as any).Translator
  if (!Translator) return null
  try {
    const availability = await Translator.availability({
      sourceLanguage: src,
      targetLanguage: tgt,
    })
    if (availability === "unavailable") return null
    return await Translator.create({
      sourceLanguage: src,
      targetLanguage: tgt,
      monitor(m: any) {
        m.addEventListener("downloadprogress", (e: any) => {
          if (typeof e?.loaded === "number") {
            postStatus(
              "downloading",
              "Descargando traductor de Chrome",
              Math.min(1, e.loaded),
            )
          }
        })
      },
    })
  } catch (error) {
    console.warn("[subvid:offscreen] Translator API no disponible", error)
    return null
  }
}

async function ensureTranslation(s: Settings) {
  builtinTranslator = null
  translationWorkerOpts = null
  if (!needsTranslation(s)) return

  // 1) Traductor integrado de Chrome (local, rápido).
  builtinTranslator = await tryBuiltinTranslator(s.sourceLang, s.targetLang)
  if (builtinTranslator) return

  // 2) MarianMT para pares comunes; 3) NLLB para el resto.
  const pair = `${s.sourceLang}:${s.targetLang}`
  const marian = MARIAN_TRANSLATION_MODELS[pair]
  const model = marian || NLLB_MODEL
  translationWorkerOpts = marian
    ? {}
    : {
        src: LANGS[s.sourceLang]?.nllb,
        tgt: LANGS[s.targetLang]?.nllb,
      }

  if (!marian && (!translationWorkerOpts.src || !translationWorkerOpts.tgt)) {
    throw new Error(`Par de idiomas no soportado: ${pair}`)
  }

  if (!translationClient) {
    translationClient = createWorkerClient(
      new Worker(new URL("./translation.worker.ts", import.meta.url), {
        type: "module",
      }),
      onWorkerProgress,
    )
  }
  await translationClient.call("ensure-translation", { model })
}

async function translateText(text: string): Promise<string | null> {
  if (builtinTranslator) {
    return String(await builtinTranslator.translate(text))
  }
  if (translationClient && translationWorkerOpts) {
    const result = await translationClient.call("translate", {
      texts: [text],
      ...translationWorkerOpts,
    })
    const first = Array.isArray(result) ? result[0] : result
    return String(first?.translation_text ?? "")
  }
  return null
}

// ---------------------------------------------------------------------------
// Inicio / parada
// ---------------------------------------------------------------------------

async function start(streamId: string, newSettings: Settings) {
  await stopAudioOnly()
  settings = newSettings
  running = true
  lastCueText = ""
  resetChunk()
  resamplePos = 0
  resamplePrev = 0
  pendingChunks.length = 0

  postStatus("loading", "Capturando audio de la pestaña…")

  media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as any,
    video: false,
  })

  const track = media.getAudioTracks()[0]
  if (track) {
    track.onended = () => {
      toBackground({ type: "capture-ended" })
    }
  }

  audioCtx = new AudioContext()
  sourceNode = audioCtx.createMediaStreamSource(media)

  // tabCapture silencia la pestaña: re-emitimos el audio para el usuario.
  sourceNode.connect(audioCtx.destination)

  // ScriptProcessor para extraer PCM (sin AudioWorklet para simplificar el bundle).
  processor = audioCtx.createScriptProcessor(4096, 1, 1)
  const silent = audioCtx.createGain()
  silent.gain.value = 0
  sourceNode.connect(processor)
  processor.connect(silent)
  silent.connect(audioCtx.destination)

  const sampleRate = audioCtx.sampleRate
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    handleAudioBlock(new Float32Array(input), sampleRate)
  }

  modelsReady = (async () => {
    postStatus("loading", "Cargando modelo de voz (Whisper)…")
    await ensureAsr(newSettings)
    if (needsTranslation(newSettings)) {
      postStatus("loading", "Preparando traductor…")
      await ensureTranslation(newSettings)
    }
    postStatus("listening", "Escuchando…")
  })()

  modelsReady.catch((error) => {
    console.error("[subvid:offscreen] model load failed", error)
    postStatus("error", String(error?.message || error))
    void stopAudioOnly()
  })
}

/** Detiene captura y audio, pero conserva los workers con modelos cargados. */
async function stopAudioOnly() {
  running = false
  pendingChunks.length = 0
  resetChunk()

  processor?.disconnect()
  processor && (processor.onaudioprocess = null)
  processor = null
  sourceNode?.disconnect()
  sourceNode = null
  if (media) {
    for (const track of media.getTracks()) track.stop()
    media = null
  }
  if (audioCtx) {
    try {
      await audioCtx.close()
    } catch {
      /* ya cerrado */
    }
    audioCtx = null
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return
  if (message.type === "start") {
    start(message.streamId, message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[subvid:offscreen] start failed", error)
        postStatus("error", String(error?.message || error))
        sendResponse({ ok: false, error: String(error?.message || error) })
      })
    return true
  }
  if (message.type === "stop") {
    void stopAudioOnly()
    sendResponse({ ok: true })
  }
})
