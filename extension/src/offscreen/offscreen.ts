// Documento offscreen: recibe el streamId de tabCapture, captura el audio de
// la pestaña, lo trocea con VAD adaptativo y lo pasa por Whisper + traducción
// en colas solapadas (original primero, traducción actualiza el mismo cue).

import { ASR_MODELS, LANGS } from "../shared/languages.ts"
import type {
  CueLatencyMetrics,
  CueStatus,
  Settings,
  StatusPhase,
  TranslationBackendInfo,
} from "../shared/types.ts"
import {
  CHUNK_HANGOVER_SECONDS,
  MAX_CHUNK_SECONDS,
  MAX_PENDING_ASR,
  MAX_PENDING_TRANSLATION,
  MIN_CHUNK_SECONDS,
  SILENCE_HOLD_SECONDS,
  SILENCE_RMS,
  TARGET_SR,
  TRANSLATION_CONTEXT_CUES,
} from "./chunkConfig.ts"
import {
  createSerialQueue,
  type AudioChunkJob,
  type TranslationJob,
} from "./pipelineQueues.ts"
import {
  TranslationProvider,
  type WorkerClient,
} from "./translationProvider.ts"
// Vite emite la URL del worklet como asset estático.
import workletUrl from "./pcm-capture.worklet.js?url"

const MODEL_LOAD_TIMEOUT_MS = 90_000
const hasWebGPU = "gpu" in navigator

// ---------------------------------------------------------------------------
// Cliente de workers
// ---------------------------------------------------------------------------

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
    call(type, payload, transfer = [], timeoutMs = 0) {
      const id = ++reqId
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (fn: (v: unknown) => void, value: unknown) => {
          if (timer) clearTimeout(timer)
          fn(value)
        }
        pending.set(id, {
          resolve: (v) => finish(resolve, v),
          reject: (e) => finish(reject, e),
        })
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`Tiempo agotado cargando modelo (${type})`))
          }, timeoutMs)
        }
        try {
          worker.postMessage({ id, type, payload }, transfer)
        } catch (error) {
          pending.delete(id)
          if (timer) clearTimeout(timer)
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
// Mensajería
// ---------------------------------------------------------------------------

function toBackground(message: Record<string, unknown>) {
  chrome.runtime
    .sendMessage({ target: "background", ...message })
    .catch(() => undefined)
}

function postStatus(phase: StatusPhase, detail?: string, progress?: number) {
  toBackground({ type: "status", phase, detail, progress })
}

function postCue(payload: {
  cueId: string
  status: CueStatus
  original: string
  translated: string | null
  seconds: number
  metrics?: CueLatencyMetrics
}) {
  toBackground({
    type: "cue",
    ...payload,
    translationBackend: activeTranslationBackend,
  })
}

function postTranslationBackend(backend: TranslationBackendInfo | null) {
  activeTranslationBackend = backend
  toBackground({ type: "translation-backend", backend })
}

// ---------------------------------------------------------------------------
// Estado de sesión
// ---------------------------------------------------------------------------

let running = false
let settings: Settings | null = null

let media: MediaStream | null = null
let audioCtx: AudioContext | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let processor: ScriptProcessorNode | null = null
let workletNode: AudioWorkletNode | null = null
let silentGain: GainNode | null = null

let asrClient: WorkerClient | null = null
let translationProvider: TranslationProvider | null = null
let activeTranslationBackend: TranslationBackendInfo | null = null
let modelsReady: Promise<void> | null = null

/** Idioma efectivo (manual o detectado tras ASR cuando sourceLang=auto). */
let effectiveSourceLang: string | null = null

let nextChunkId = 1
let nextCueSeq = 1
let lastCueText = ""
let activeCueId: string | null = null
let activeCueGeneration = 0
let activeCueOriginal = ""
const recentOriginals: string[] = []

// ---------------------------------------------------------------------------
// Captura + troceado
// ---------------------------------------------------------------------------

let pcmParts: Float32Array[] = []
let pcmLength = 0
let trailingSilence = 0
let chunkHasVoice = false
let hangoverSamplesLeft = 0
let flushPending = false

let resamplePos = 0
let resamplePrev = 0

function resetChunk() {
  pcmParts = []
  pcmLength = 0
  trailingSilence = 0
  chunkHasVoice = false
  hangoverSamplesLeft = 0
  flushPending = false
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
    // Si había un flush por silencio pendiente y volvió la voz, cancelamos hangover.
    if (flushPending) {
      flushPending = false
      hangoverSamplesLeft = 0
    }
  }

  const resampled = downsample(block, sampleRate / TARGET_SR)
  if (resampled.length) {
    pcmParts.push(resampled)
    pcmLength += resampled.length
  }

  const seconds = pcmLength / TARGET_SR

  if (flushPending) {
    hangoverSamplesLeft -= resampled.length
    if (hangoverSamplesLeft <= 0) {
      flushChunk()
      return
    }
  }

  const naturalPause =
    chunkHasVoice &&
    seconds >= MIN_CHUNK_SECONDS &&
    trailingSilence >= SILENCE_HOLD_SECONDS

  if (seconds >= MAX_CHUNK_SECONDS) {
    // Hard max: sin hangover (el audio ya es largo).
    flushPending = false
    hangoverSamplesLeft = 0
    flushChunk()
    return
  }

  if (naturalPause && !flushPending) {
    flushPending = true
    hangoverSamplesLeft = Math.floor(CHUNK_HANGOVER_SECONDS * TARGET_SR)
    if (hangoverSamplesLeft <= 0) flushChunk()
  }
}

function flushChunk() {
  flushPending = false
  hangoverSamplesLeft = 0
  if (!chunkHasVoice) {
    resetChunk()
    return
  }
  const chunk = new Float32Array(pcmLength)
  let offset = 0
  for (const part of pcmParts) {
    chunk.set(part, offset)
    offset += part.length
  }
  const seconds = chunk.length / TARGET_SR
  resetChunk()

  const language =
    settings?.sourceLang && settings.sourceLang !== "auto"
      ? settings.sourceLang
      : null

  asrQueue.enqueue({
    chunkId: nextChunkId++,
    audioCapturedAt: performance.now(),
    pcm: chunk,
    seconds,
    language,
  })
}

// ---------------------------------------------------------------------------
// Detección de idioma (sourceLang=auto)
// ---------------------------------------------------------------------------

async function detectLanguageFromText(text: string): Promise<string | null> {
  try {
    const result = await chrome.i18n.detectLanguage(text)
    const top = result?.languages?.[0]
    if (!top?.language || top.language === "und") return null
    // Chrome devuelve "zh-CN" etc.; normalizamos a código corto de LANGS.
    const code = top.language.toLowerCase().split("-")[0]
    if (code && code in LANGS) return code
    return null
  } catch {
    return null
  }
}

function isPrefixExtension(previous: string, next: string) {
  const a = previous.trim().toLowerCase()
  const b = next.trim().toLowerCase()
  if (!a || !b || a === b) return false
  return b.startsWith(a) || a.startsWith(b)
}

function pushRecentOriginal(text: string) {
  recentOriginals.push(text)
  while (recentOriginals.length > TRANSLATION_CONTEXT_CUES) {
    recentOriginals.shift()
  }
}

function contextForTranslation(current: string) {
  return recentOriginals.filter((t) => t !== current).slice(-TRANSLATION_CONTEXT_CUES)
}

// ---------------------------------------------------------------------------
// Colas ASR + traducción
// ---------------------------------------------------------------------------

async function runAsrJob(job: AudioChunkJob) {
  if (!modelsReady || !asrClient || !settings) return
  await modelsReady
  if (!running) return

  const asrStartedAt = performance.now()
  const output = await asrClient.call(
    "transcribe",
    {
      audio: job.pcm,
      language: job.language,
    },
    [job.pcm.buffer],
  )
  const asrFinishedAt = performance.now()

  const original = cleanTranscript(String(output?.text ?? ""))
  if (!original) return

  // Dedup exacto consecutivo.
  if (original === lastCueText && !isPrefixExtension(activeCueOriginal, original)) {
    return
  }

  // Idioma auto: detectar y cachear; recrear traductor si cambia el par.
  if (settings.sourceLang === "auto") {
    const detected = await detectLanguageFromText(original)
    if (detected) effectiveSourceLang = detected
  } else {
    effectiveSourceLang = settings.sourceLang
  }

  const src = effectiveSourceLang || settings.sourceLang
  const wantsTranslation =
    settings.targetLang !== "none" &&
    src !== "auto" &&
    settings.targetLang !== src

  let cueId: string
  let generation: number

  if (
    activeCueId &&
    activeCueOriginal &&
    isPrefixExtension(activeCueOriginal, original)
  ) {
    // Extensión incremental del mismo subtítulo.
    cueId = activeCueId
    activeCueGeneration += 1
    generation = activeCueGeneration
    activeCueOriginal =
      original.length >= activeCueOriginal.length ? original : activeCueOriginal
    if (recentOriginals.length) {
      recentOriginals[recentOriginals.length - 1] = activeCueOriginal
    }
  } else {
    cueId = `cue-${nextCueSeq++}`
    activeCueId = cueId
    activeCueGeneration = 1
    generation = 1
    activeCueOriginal = original
    pushRecentOriginal(original)
  }

  lastCueText = activeCueOriginal

  const metrics: CueLatencyMetrics = {
    audioCapturedAt: job.audioCapturedAt,
    asrStartedAt,
    asrFinishedAt,
  }

  postCue({
    cueId,
    status: wantsTranslation ? "translation_pending" : "transcript_confirmed",
    original: activeCueOriginal,
    translated: null,
    seconds: job.seconds,
    metrics,
  })

  if (!wantsTranslation || !translationProvider) return

  translationQueue.enqueue({
    chunkId: job.chunkId,
    cueId,
    generation,
    text: activeCueOriginal,
    previousContext: contextForTranslation(activeCueOriginal),
    sourceLang: src,
    targetLang: settings.targetLang,
    seconds: job.seconds,
    audioCapturedAt: job.audioCapturedAt,
    asrStartedAt,
    asrFinishedAt,
  })
}

async function runTranslationJob(job: TranslationJob) {
  if (!running || !translationProvider || !settings) return

  // Descartar si el cue ya avanzó (fusión ASR posterior).
  if (
    job.cueId === activeCueId &&
    job.generation < activeCueGeneration
  ) {
    return
  }

  const translationStartedAt = performance.now()
  let translated: string | null = null
  try {
    translated = await translationProvider.translate({
      text: job.text,
      previousContext: job.previousContext,
      sourceLang: job.sourceLang,
      targetLang: job.targetLang,
    })
  } catch (error) {
    console.warn("[subvid:offscreen] translation failed", error)
  }
  const translationFinishedAt = performance.now()

  if (!running) return
  if (
    job.cueId === activeCueId &&
    job.generation < activeCueGeneration
  ) {
    return
  }

  postCue({
    cueId: job.cueId,
    status: "translation_confirmed",
    original: job.text,
    translated,
    seconds: job.seconds,
    metrics: {
      audioCapturedAt: job.audioCapturedAt,
      asrStartedAt: job.asrStartedAt,
      asrFinishedAt: job.asrFinishedAt,
      translationStartedAt,
      translationFinishedAt,
    },
  })
}

const asrQueue = createSerialQueue<AudioChunkJob>(runAsrJob, {
  maxPending: MAX_PENDING_ASR,
  dropOldest: true,
})

const translationQueue = createSerialQueue<TranslationJob>(runTranslationJob, {
  maxPending: MAX_PENDING_TRANSLATION,
  dropOldest: true,
})

function cleanTranscript(text: string) {
  const trimmed = text.trim()
  if (!trimmed || /^[\s.\-–—♪♫\[\]()]*$/.test(trimmed)) return ""
  return trimmed
}

// ---------------------------------------------------------------------------
// Modelos
// ---------------------------------------------------------------------------

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
    await asrClient.call(
      "ensure-asr",
      { model, webgpu: hasWebGPU },
      [],
      MODEL_LOAD_TIMEOUT_MS,
    )
  } catch (error) {
    if (!hasWebGPU) throw error
    console.warn("[subvid:offscreen] WebGPU falló, reintentando en WASM", error)
    asrClient.terminate()
    asrClient = createAsrWorker()
    await asrClient.call(
      "ensure-asr",
      { model, webgpu: false },
      [],
      MODEL_LOAD_TIMEOUT_MS,
    )
  }
}

function createTranslationProvider() {
  return new TranslationProvider({
    createWorkerClient,
    onProgress: onWorkerProgress,
    postStatus: (phase, detail, progress) =>
      postStatus(phase as StatusPhase, detail, progress),
    onBackendChange: postTranslationBackend,
  })
}

async function ensureTranslationWarmup(s: Settings) {
  if (!translationProvider) translationProvider = createTranslationProvider()
  // Con auto no sabemos el par hasta el primer ASR; no bloqueamos el warmup
  // de Marian/NLLB. Si el idioma es fijo, precargamos en paralelo con ASR.
  if (s.sourceLang === "auto") {
    if (s.targetLang === "none") {
      postTranslationBackend(null)
      return
    }
    // Intentamos precargar Translator en→target como heurística frecuente;
    // el provider recreará el par al detectar el idioma real.
    try {
      await translationProvider.ensure("en", s.targetLang)
    } catch {
      postTranslationBackend(null)
    }
    return
  }
  if (s.targetLang === "none" || s.targetLang === s.sourceLang) {
    postTranslationBackend(null)
    return
  }
  await translationProvider.ensure(s.sourceLang, s.targetLang)
}

// ---------------------------------------------------------------------------
// Audio capture: AudioWorklet con fallback ScriptProcessor
// ---------------------------------------------------------------------------

async function connectCaptureGraph(stream: MediaStream) {
  audioCtx = new AudioContext()
  sourceNode = audioCtx.createMediaStreamSource(stream)
  // tabCapture silencia la pestaña: re-emitimos el audio para el usuario.
  sourceNode.connect(audioCtx.destination)

  silentGain = audioCtx.createGain()
  silentGain.gain.value = 0
  silentGain.connect(audioCtx.destination)

  const sampleRate = audioCtx.sampleRate
  const onPcm = (samples: Float32Array) => {
    handleAudioBlock(samples, sampleRate)
  }

  try {
    await audioCtx.audioWorklet.addModule(workletUrl)
    workletNode = new AudioWorkletNode(audioCtx, "pcm-capture")
    workletNode.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) onPcm(event.data)
    }
    sourceNode.connect(workletNode)
    workletNode.connect(silentGain)
    console.info("[subvid:offscreen] AudioWorklet activo")
  } catch (error) {
    console.warn(
      "[subvid:offscreen] AudioWorklet no disponible, usando ScriptProcessor",
      error,
    )
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    sourceNode.connect(processor)
    processor.connect(silentGain)
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      onPcm(new Float32Array(input))
    }
  }
}

// ---------------------------------------------------------------------------
// Inicio / parada
// ---------------------------------------------------------------------------

async function start(streamId: string, newSettings: Settings) {
  await stopAudioOnly()
  settings = newSettings
  running = true
  lastCueText = ""
  activeCueId = null
  activeCueGeneration = 0
  activeCueOriginal = ""
  recentOriginals.length = 0
  nextChunkId = 1
  nextCueSeq = 1
  effectiveSourceLang =
    newSettings.sourceLang === "auto" ? null : newSettings.sourceLang
  resetChunk()
  resamplePos = 0
  resamplePrev = 0
  asrQueue.clear()
  translationQueue.clear()

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

  await connectCaptureGraph(media)

  modelsReady = (async () => {
    postStatus("loading", "Cargando modelos…")
    const tasks: Promise<void>[] = [ensureAsr(newSettings)]
    if (newSettings.targetLang !== "none") {
      tasks.push(ensureTranslationWarmup(newSettings))
    } else {
      postTranslationBackend(null)
    }
    await Promise.all(tasks)
    postStatus("listening", "Escuchando…")
  })()

  modelsReady.catch((error) => {
    console.error("[subvid:offscreen] model load failed", error)
    postStatus("error", String(error?.message || error))
    void stopAudioOnly().finally(() => {
      toBackground({ type: "capture-ended" })
    })
  })
}

function releaseModelWorkers() {
  modelsReady = null
  if (asrClient) {
    asrClient.terminate()
    asrClient = null
  }
  if (translationProvider) {
    translationProvider.dispose()
    translationProvider = null
  }
}

async function stopAudioOnly() {
  running = false
  activeTranslationBackend = null
  asrQueue.clear()
  translationQueue.clear()
  resetChunk()
  releaseModelWorkers()

  if (workletNode) {
    try {
      workletNode.port.onmessage = null
      workletNode.disconnect()
    } catch {
      /* ya desconectado */
    }
    workletNode = null
  }
  processor?.disconnect()
  if (processor) processor.onaudioprocess = null
  processor = null
  silentGain?.disconnect()
  silentGain = null
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
