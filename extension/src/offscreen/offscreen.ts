// Documento offscreen: recibe el streamId de tabCapture, captura el audio de
// la pestaña, lo trocea con VAD adaptativo y lo pasa por Whisper + traducción
// en colas solapadas (original primero, traducción actualiza el mismo cue).

import { ASR_MODELS } from "../shared/languages.ts"
import { normalizeTranslationEngine } from "../shared/translationEngines.ts"
import type {
  CueLatencyMetrics,
  CueLifecycle,
  CueStatus,
  Settings,
  StatusPhase,
  TranslationBackendInfo,
  TranslationEngineChoice,
} from "../shared/types.ts"
import { CascadingTranslationEngine } from "./cascadingTranslationEngine.ts"
import {
  adaptiveMinChunkSeconds,
  chunkProfileFor,
  MAX_PENDING_TRANSLATION,
  SILENCE_RMS,
  TARGET_SR,
  type ChunkProfile,
} from "./chunkConfig.ts"
import { conversationContext } from "./conversationContext.ts"
import {
  computeCueStability,
  markCueFinal,
  type CueStabilityState,
} from "./cueStability.ts"
import { languageDetector } from "./languageDetector.ts"
import { pendingFragment } from "./pendingFragment.ts"
import { pipelineMetrics } from "./pipelineMetrics.ts"
import {
  createSerialQueue,
  type AudioChunkJob,
  type TranslationJob,
} from "./pipelineQueues.ts"
import { subtitleDeduplicator } from "./subtitleDeduplicator.ts"
import type { WorkerClient } from "./translationProvider.ts"
import { enrichLatencyMetrics } from "../shared/latencyDebug.ts"
// Vite emite la URL del worklet como asset estático.
// AudioWorklet reduce jitter de captura, pero el cuello de botella dominante
// sigue siendo Whisper + traducción; el fallback ScriptProcessor se mantiene.
import workletUrl from "./pcm-capture.worklet.js?url"

const MODEL_LOAD_TIMEOUT_MS = 90_000
const hasWebGPU = "gpu" in navigator

/** Timestamps de latencia: Date.now() es comparable entre offscreen y content. */
function nowMs() {
  return Date.now()
}

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
    if (type === "log") {
      console.info(String(event.data.message || ""))
      return
    }
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (type === "error") {
      const err = new Error(event.data.error)
      ;(err as any).structured = event.data.structured
      request.reject(err)
    } else request.resolve(event.data.result)
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
  confirmedText?: string
  deltaText?: string
  seconds: number
  stabilityScore?: number
  isFinal?: boolean
  lifecycle?: CueLifecycle
  metrics?: CueLatencyMetrics
}) {
  const isFinal = payload.isFinal === true
  toBackground({
    type: "cue",
    ...payload,
    isFinal,
    lifecycle: payload.lifecycle || (isFinal ? "FINAL" : "PROVISIONAL"),
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
let translationEngine: CascadingTranslationEngine | null = null
let activeTranslationBackend: TranslationBackendInfo | null = null
let modelsReady: Promise<void> | null = null
/** Fingerprint de settings de modelos para reutilizar workers al reiniciar. */
let loadedModelsKey: string | null = null

function modelsKeyFor(s: Settings) {
  const engine = normalizeTranslationEngine(s.translationEngine, s)
  return `${s.model}|${s.sourceLang}|${s.targetLang}|${engine}`
}

/** Idioma efectivo (manual o detectado tras ASR cuando sourceLang=auto). */
let effectiveSourceLang: string | null = null

let nextChunkId = 1
let nextCueSeq = 1
let lastCueText = ""
let activeCueId: string | null = null
let activeCueGeneration = 0
let activeCueOriginal = ""
/** Estado de estabilidad del cue activo (hipótesis ASR). */
let activeCueStability: CueStabilityState | null = null
/** Mapa cueId → estabilidad (para traducciones que confirman final). */
const cueStabilityById = new Map<string, CueStabilityState>()

// ---------------------------------------------------------------------------
// Captura + troceado
// ---------------------------------------------------------------------------

let pcmParts: Float32Array[] = []
let pcmLength = 0
let trailingSilence = 0
let chunkHasVoice = false
let hangoverSamplesLeft = 0
let flushPending = false
/** Instrumentación: inicio de voz del fragmento en curso. */
let chunkAudioStartedAt = 0
/** Segundos de silencio acumulados dentro del fragmento (para MIN adaptativo). */
let chunkSilenceSeconds = 0
/** Muestras de solape del chunk anterior (no cuentan para MIN/MAX). */
let overlapLength = 0
/** Perfil Live/Quality activo. */
let activeProfile: ChunkProfile = chunkProfileFor("live")

let resamplePos = 0
let resamplePrev = 0

function resetChunk() {
  pcmParts = []
  pcmLength = 0
  trailingSilence = 0
  chunkHasVoice = false
  hangoverSamplesLeft = 0
  flushPending = false
  chunkAudioStartedAt = 0
  chunkSilenceSeconds = 0
  overlapLength = 0
}

function currentProfile(): ChunkProfile {
  return activeProfile
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
  const profile = currentProfile()

  const blockSeconds = block.length / sampleRate
  const rms = rmsOf(block)
  if (rms < SILENCE_RMS) {
    trailingSilence += blockSeconds
    if (chunkHasVoice) chunkSilenceSeconds += blockSeconds
  } else {
    if (!chunkHasVoice) {
      // Solo instrumentación: marca el inicio de voz del fragmento.
      chunkAudioStartedAt = nowMs()
    }
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
  // El solape del chunk anterior no cuenta para decidir cuándo cortar.
  const effectiveSeconds = Math.max(0, (pcmLength - overlapLength) / TARGET_SR)

  if (flushPending) {
    hangoverSamplesLeft -= resampled.length
    if (hangoverSamplesLeft <= 0) {
      flushChunk()
      return
    }
  }

  const silenceRatio =
    effectiveSeconds > 0 ? chunkSilenceSeconds / effectiveSeconds : 0
  const minChunk = adaptiveMinChunkSeconds(profile, {
    chunkSeconds: effectiveSeconds,
    trailingSilence,
    silenceRatio,
  })

  const naturalPause =
    chunkHasVoice &&
    effectiveSeconds >= minChunk &&
    trailingSilence >= profile.silenceHold

  if (effectiveSeconds >= profile.maxChunk) {
    // Hard max: sin hangover (el audio ya es largo).
    flushPending = false
    hangoverSamplesLeft = 0
    flushChunk()
    return
  }

  if (naturalPause && !flushPending) {
    flushPending = true
    hangoverSamplesLeft = Math.floor(profile.hangover * TARGET_SR)
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
  const silenceDurationSeconds = trailingSilence
  const chunk = new Float32Array(pcmLength)
  let offset = 0
  for (const part of pcmParts) {
    chunk.set(part, offset)
    offset += part.length
  }
  const seconds = chunk.length / TARGET_SR
  const audioCapturedAt = chunkAudioStartedAt || nowMs()
  const chunkCreatedAt = nowMs()

  // Solapamiento: conservar el final del audio para el siguiente fragmento
  // (reduce cortes de idea cuando se flushea por MAX o pausa).
  const profile = currentProfile()
  const overlapSamples = Math.min(
    chunk.length,
    Math.floor(profile.overlap * TARGET_SR),
  )
  const overlap =
    overlapSamples > 0 ? chunk.slice(chunk.length - overlapSamples) : null

  resetChunk()
  if (overlap && overlap.length) {
    pcmParts = [overlap]
    pcmLength = overlap.length
    overlapLength = overlap.length
    // El solape no cuenta como “voz nueva” hasta que llegue audio fresco;
    // así no flusheamos en bucle el mismo solape.
    chunkHasVoice = false
    chunkAudioStartedAt = 0
  }

  const language =
    settings?.sourceLang && settings.sourceLang !== "auto"
      ? settings.sourceLang
      : null

  asrQueue.enqueue({
    chunkId: nextChunkId++,
    audioCapturedAt,
    chunkCreatedAt,
    pcm: chunk,
    seconds,
    language,
    silenceDurationSeconds,
  })
}

// ---------------------------------------------------------------------------
// Colas ASR + traducción
// ---------------------------------------------------------------------------

async function runAsrJob(job: AudioChunkJob) {
  if (!modelsReady || !asrClient || !settings) return
  await modelsReady
  if (!running) return

  // Instrumentación: Whisper arranca aquí (incluye espera en cola desde chunkCreatedAt).
  const asrStartedAt = nowMs()
  const output = await asrClient.call(
    "transcribe",
    {
      audio: job.pcm,
      language: job.language,
    },
    [job.pcm.buffer],
  )
  const asrFinishedAt = nowMs()

  const baseMetrics = (): CueLatencyMetrics =>
    enrichLatencyMetrics({
      audioCapturedAt: job.audioCapturedAt,
      chunkCreatedAt: job.chunkCreatedAt,
      asrStartedAt,
      asrFinishedAt,
    })

  const original = cleanTranscript(String(output?.text ?? ""))
  if (!original) return

  // Deduplicación / continuación del último cue visible (no toca ASR).
  const dedup = subtitleDeduplicator.resolve(
    original,
    activeCueId,
    () => `cue-${nextCueSeq++}`,
  )

  if (dedup.kind === "identical" && dedup.reuse && activeCueId) {
    if (activeCueStability) {
      const stab = computeCueStability(activeCueStability, dedup.fullText)
      activeCueStability = stab.state
      cueStabilityById.set(activeCueId, stab.state)
      // Identidad ASR: solo FINAL si el boundary + fragmento lo confirman.
      const frag = pendingFragment.ingest(dedup.fullText, {
        silenceDuration: job.silenceDurationSeconds,
        audioDuration: job.seconds,
        asrConfidence: stab.stabilityScore,
        isWhisperStable: stab.isFinal,
        silenceClearSeconds: currentProfile().silenceClear,
        debug: settings.debugLatency,
      })
      if (frag.isFinal) {
        const now = nowMs()
        pipelineMetrics.finalCueCount += 1
        postCue({
          cueId: activeCueId,
          status: "transcript_confirmed",
          original: frag.text,
          confirmedText: frag.text,
          deltaText: "",
          translated: null,
          seconds: job.seconds,
          stabilityScore: stab.stabilityScore,
          isFinal: true,
          lifecycle: "FINAL",
          metrics: enrichLatencyMetrics({
            ...baseMetrics(),
            finalCueAt: now,
            finalAt: now,
            boundaryReason: frag.boundary.reason,
            boundaryConfidence: frag.boundary.confidence,
          }),
        })
      }
    }
    lastCueText = dedup.fullText
    activeCueOriginal = dedup.fullText
    return
  }

  // Idioma: manual override o LanguageDetector con caché.
  if (settings.sourceLang === "auto") {
    const detected = await languageDetector.resolve(dedup.fullText)
    if (detected) effectiveSourceLang = detected
  } else {
    effectiveSourceLang = settings.sourceLang
    languageDetector.reset()
  }

  const src = effectiveSourceLang || settings.sourceLang
  const wantsTranslation =
    settings.targetLang !== "none" &&
    src !== "auto" &&
    settings.targetLang !== src

  const cueId = dedup.cueId
  let generation: number

  if (dedup.reuse && activeCueId === cueId) {
    activeCueGeneration += 1
    generation = activeCueGeneration
    activeCueOriginal = dedup.fullText
    conversationContext.updateLatest(activeCueOriginal)
  } else {
    activeCueId = cueId
    activeCueGeneration = 1
    generation = 1
    activeCueOriginal = dedup.fullText
    conversationContext.push(activeCueOriginal)
  }

  const stability = computeCueStability(
    dedup.reuse ? activeCueStability : null,
    activeCueOriginal,
  )
  activeCueStability = stability.state
  cueStabilityById.set(cueId, stability.state)
  lastCueText = activeCueOriginal

  // Segmentación lingüística (NO TranslateGemma): provisional vs final.
  const fragment = pendingFragment.ingest(activeCueOriginal, {
    silenceDuration: job.silenceDurationSeconds,
    audioDuration: job.seconds,
    asrConfidence: stability.stabilityScore,
    isWhisperStable: stability.isFinal,
    silenceClearSeconds: currentProfile().silenceClear,
    debug: settings.debugLatency,
  })
  if (fragment.merged) pipelineMetrics.mergedCueCount += 1

  const displayText = fragment.text
  activeCueOriginal = displayText

  // FINAL solo cuando el detector de frontera lo confirma (ASR + silencio + gramática).
  // Sin traducción, transcript_confirmed + FINAL basta para UI.
  const isFinal = fragment.isFinal
  if (isFinal) {
    pipelineMetrics.finalCueCount += 1
    const prevStab = cueStabilityById.get(cueId) || activeCueStability
    const finalStab = markCueFinal(prevStab, displayText)
    cueStabilityById.set(cueId, finalStab.state)
    if (cueId === activeCueId) activeCueStability = finalStab.state
  } else {
    pipelineMetrics.provisionalCueCount += 1
  }

  const confirmedText = isFinal
    ? displayText
    : dedup.deltaText
      ? dedup.confirmedText
      : displayText
  const deltaText = isFinal ? "" : dedup.deltaText

  const metrics: CueLatencyMetrics = {
    ...baseMetrics(),
    boundaryReason: fragment.boundary.reason,
    boundaryConfidence: fragment.boundary.confidence,
  }
  if (isFinal) {
    const now = nowMs()
    metrics.finalCueAt = now
    metrics.finalAt = now
    metrics.cueFinalizationDuration = now - job.audioCapturedAt
    pipelineMetrics.cueFinalizationDuration = metrics.cueFinalizationDuration
  }

  postCue({
    cueId,
    status: wantsTranslation
      ? "translation_pending"
      : isFinal
        ? "transcript_confirmed"
        : "transcript_pending",
    original: displayText,
    confirmedText,
    deltaText,
    translated: null,
    seconds: job.seconds,
    stabilityScore: stability.stabilityScore,
    isFinal,
    lifecycle: isFinal ? "FINAL" : "PROVISIONAL",
    metrics: enrichLatencyMetrics(metrics),
  })

  if (!wantsTranslation || !translationEngine) return

  // Traducción en paralelo con ASR del siguiente chunk; TTS solo si isFinal.
  translationQueue.enqueue({
    chunkId: job.chunkId,
    cueId,
    generation,
    text: displayText,
    previousContext: conversationContext.getContextFor(displayText),
    sourceLang: src,
    targetLang: settings.targetLang,
    seconds: job.seconds,
    audioCapturedAt: job.audioCapturedAt,
    chunkCreatedAt: job.chunkCreatedAt,
    asrStartedAt,
    asrFinishedAt,
    isFinal,
    boundaryReason: fragment.boundary.reason,
    boundaryConfidence: fragment.boundary.confidence,
    fragmentStartedAt: job.audioCapturedAt,
  })
}

async function runTranslationJob(job: TranslationJob) {
  if (!running || !translationEngine || !settings) return

  // Descartar si el cue ya avanzó (fusión ASR posterior).
  if (job.cueId === activeCueId && job.generation < activeCueGeneration) {
    return
  }

  const translationStartedAt = nowMs()
  let translated: string | null = null
  try {
    const result = await translationEngine.translate({
      text: job.text,
      previousContext: job.previousContext,
      sourceLang: job.sourceLang,
      targetLang: job.targetLang,
    })
    translated = result.text
    if (result.backend) activeTranslationBackend = result.backend
  } catch (error) {
    console.warn("[subvid:offscreen] translation failed", error)
  }
  const translationFinishedAt = nowMs()
  pipelineMetrics.translationDuration =
    translationFinishedAt - translationStartedAt

  if (!running) return
  if (job.cueId === activeCueId && job.generation < activeCueGeneration) {
    return
  }

  // PROVISIONAL → UI con traducción, sin marcar FINAL (no TTS).
  // FINAL → UI + translation_confirmed + isFinal (TTS en background).
  if (job.isFinal) {
    const prevStab = cueStabilityById.get(job.cueId) || activeCueStability
    const finalStab = markCueFinal(prevStab, job.text)
    cueStabilityById.set(job.cueId, finalStab.state)
    if (job.cueId === activeCueId) activeCueStability = finalStab.state

    postCue({
      cueId: job.cueId,
      status: "translation_confirmed",
      original: job.text,
      confirmedText: job.text,
      deltaText: "",
      translated,
      seconds: job.seconds,
      stabilityScore: finalStab.stabilityScore,
      isFinal: true,
      lifecycle: "FINAL",
      metrics: enrichLatencyMetrics({
        audioCapturedAt: job.audioCapturedAt,
        chunkCreatedAt: job.chunkCreatedAt,
        asrStartedAt: job.asrStartedAt,
        asrFinishedAt: job.asrFinishedAt,
        translationStartedAt,
        translationFinishedAt,
        finalCueAt: translationFinishedAt,
        finalAt: translationFinishedAt,
        translationEngine: pipelineMetrics.translationEngine,
        translationDuration: pipelineMetrics.translationDuration,
        modelLoadDuration: pipelineMetrics.modelLoadDuration,
        boundaryReason: job.boundaryReason,
        boundaryConfidence: job.boundaryConfidence,
        cueFinalizationDuration:
          translationFinishedAt - (job.fragmentStartedAt || job.audioCapturedAt),
      }),
    })
    if (translated) pipelineMetrics.ttsQueuedCount += 1
  } else {
    pipelineMetrics.ttsSkippedProvisional += 1
    postCue({
      cueId: job.cueId,
      status: "translation_pending",
      original: job.text,
      confirmedText: job.text,
      deltaText: "",
      translated,
      seconds: job.seconds,
      stabilityScore: cueStabilityById.get(job.cueId)?.score,
      isFinal: false,
      lifecycle: "PROVISIONAL",
      metrics: enrichLatencyMetrics({
        audioCapturedAt: job.audioCapturedAt,
        chunkCreatedAt: job.chunkCreatedAt,
        asrStartedAt: job.asrStartedAt,
        asrFinishedAt: job.asrFinishedAt,
        translationStartedAt,
        translationFinishedAt,
        translationEngine: pipelineMetrics.translationEngine,
        translationDuration: pipelineMetrics.translationDuration,
        boundaryReason: job.boundaryReason,
        boundaryConfidence: job.boundaryConfidence,
      }),
    })
  }
}

const asrQueue = createSerialQueue<AudioChunkJob>(runAsrJob, {
  maxPending: () => currentProfile().maxPendingAsr,
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
    key === "asr"
      ? "Descargando modelo de voz"
      : key === "translategemma"
        ? "Descargando TranslateGemma 4B"
        : "Descargando traductor"
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

function createTranslationEngine(s: Settings) {
  const engine = normalizeTranslationEngine(s.translationEngine, s)
  return new CascadingTranslationEngine({
    createWorkerClient,
    onProgress: onWorkerProgress,
    postStatus: (phase, detail, progress) =>
      postStatus(phase as StatusPhase, detail, progress),
    onBackendChange: postTranslationBackend,
    translationEngine: engine as TranslationEngineChoice,
    preferTranslateGemma: engine === "auto" || engine === "translategemma",
    translationModelSize: engine === "translategemma" ? "4b" : s.translationModelSize || "4b",
  })
}

async function ensureTranslationWarmup(s: Settings) {
  const key = modelsKeyFor(s)
  if (translationEngine && loadedModelsKey && loadedModelsKey !== key) {
    translationEngine.dispose()
    translationEngine = null
  }
  if (!translationEngine) translationEngine = createTranslationEngine(s)
  // Con auto no sabemos el par hasta el primer ASR; no bloqueamos el warmup
  // de Marian/NLLB. Si el idioma es fijo, precargamos en paralelo con ASR.
  if (s.sourceLang === "auto") {
    if (s.targetLang === "none") {
      postTranslationBackend(null)
      return
    }
    try {
      await translationEngine.warmUp("en", s.targetLang)
    } catch {
      postTranslationBackend(null)
    }
    return
  }
  if (s.targetLang === "none" || s.targetLang === s.sourceLang) {
    postTranslationBackend(null)
    return
  }
  await translationEngine.warmUp(s.sourceLang, s.targetLang)
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
  // Conserva modelos en RAM entre Detener/Activar (evita “re-descarga” aparente).
  await stopAudioOnly(false)
  settings = newSettings
  running = true
  activeProfile = chunkProfileFor(newSettings.latencyMode || "live")
  conversationContext.reset()
  conversationContext.setMaxCues(activeProfile.contextCues)
  languageDetector.reset()
  subtitleDeduplicator.reset()
  pendingFragment.reset()
  pipelineMetrics.reset()
  lastCueText = ""
  activeCueId = null
  activeCueGeneration = 0
  activeCueOriginal = ""
  activeCueStability = null
  cueStabilityById.clear()
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

  const nextKey = modelsKeyFor(newSettings)
  const canReuseModels =
    loadedModelsKey === nextKey &&
    !!asrClient &&
    (newSettings.targetLang === "none" || !!translationEngine)

  modelsReady = (async () => {
    if (canReuseModels) {
      postStatus("listening", "Reutilizando modelos en memoria…")
      if (translationEngine?.getBackend()) {
        postTranslationBackend(translationEngine.getBackend())
      }
      postStatus("listening", "Escuchando…")
      return
    }

    if (loadedModelsKey && loadedModelsKey !== nextKey) {
      releaseModelWorkers()
    }

    postStatus("loading", "Cargando modelos…")
    const tasks: Promise<void>[] = [ensureAsr(newSettings)]
    if (newSettings.targetLang !== "none") {
      tasks.push(ensureTranslationWarmup(newSettings))
    } else {
      postTranslationBackend(null)
    }
    await Promise.all(tasks)
    loadedModelsKey = nextKey
    postStatus("listening", "Escuchando…")
  })()

  modelsReady.catch((error) => {
    console.error("[subvid:offscreen] model load failed", error)
    postStatus("error", String(error?.message || error))
    void stopAudioOnly(false).finally(() => {
      toBackground({ type: "capture-ended" })
    })
  })
}

function releaseModelWorkers() {
  modelsReady = null
  loadedModelsKey = null
  if (asrClient) {
    asrClient.terminate()
    asrClient = null
  }
  if (translationEngine) {
    translationEngine.dispose()
    translationEngine = null
  }
}

/** Detiene captura de audio. Por defecto CONSERVA modelos en memoria. */
async function stopAudioOnly(releaseModels = false) {
  running = false
  activeTranslationBackend = releaseModels ? null : activeTranslationBackend
  asrQueue.clear()
  translationQueue.clear()
  resetChunk()
  if (releaseModels) releaseModelWorkers()

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

async function clearModelCaches() {
  const keys = await caches.keys()
  let deleted = 0
  for (const key of keys) {
    if (/huggingface|transformers|ort|onnx|xenova|gemm/i.test(key)) {
      if (await caches.delete(key)) deleted++
    }
  }
  // IndexedDB que suelen usar transformers.js / ORT
  const idbNames = [
    "transformers-cache",
    "huggingface-transformers",
  ]
  for (const name of idbNames) {
    try {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = () => resolve()
        req.onerror = () => resolve()
        req.onblocked = () => resolve()
      })
    } catch {
      /* ignore */
    }
  }
  return deleted
}

async function resetModels() {
  await stopAudioOnly(true)
  const deleted = await clearModelCaches()
  postStatus("idle", `Modelos y caché borrados (${deleted} caches)`)
  return deleted
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
    void stopAudioOnly(false)
    sendResponse({ ok: true })
    return
  }
  if (message.type === "reset-models") {
    resetModels()
      .then((deleted) => sendResponse({ ok: true, deleted }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String((error as Error)?.message || error),
        }),
      )
    return true
  }
  if (message.type === "run-translategemma-diagnostic") {
    // Validación REAL fuera del pipeline (sin cascade / Whisper / TTS).
    import("./translateGemmaDiagnostic.ts")
      .then(({ runTranslateGemmaDiagnostic }) =>
        runTranslateGemmaDiagnostic((progress) => {
          toBackground({
            type: "translategemma-diagnostic-progress",
            ...progress,
          })
        }),
      )
      .then((report) => {
        toBackground({
          type: "translategemma-diagnostic-result",
          report,
        })
        sendResponse({ ok: true, report })
      })
      .catch((error) => {
        console.error("[subvid:offscreen] diagnostic failed", error)
        sendResponse({
          ok: false,
          error: String((error as Error)?.message || error),
        })
      })
    return true
  }
})
