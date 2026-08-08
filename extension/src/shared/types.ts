export type SubtitleStyle = {
  /** Multiplicador sobre el tamaño automático según el ancho del video. */
  fontScale: number
  textColor: string
  backgroundColor: string
  /** 0..1 */
  backgroundOpacity: number
}

/** Preferencia de latencia vs calidad de troceado/contexto. */
export type LatencyMode = "live" | "quality"

export type TranslationModelSize = "4b" | "fallback"

/**
 * Motor de traducción preferido (independiente del navegador).
 * "auto" = cascade: TranslateGemma → Chrome → Marian → NLLB.
 */
export type TranslationEngineChoice =
  | "auto"
  | "translategemma"
  | "chrome-translator"
  | "marian"
  | "nllb"

export type Settings = {
  /** Idioma hablado en el video (código tipo "en") o "auto". */
  sourceLang: string
  /** Idioma destino de la traducción, o "none" para solo transcribir. */
  targetLang: string
  /** Tamaño del modelo Whisper. */
  model: "tiny" | "base" | "small"
  /** Mostrar también el texto original junto a la traducción. */
  dual: boolean
  /** Mostrar métricas de latencia ASR/traducción en overlay y popup. */
  debugLatency: boolean
  /**
   * Live: chunks más cortos, cola ASR=1, contexto corto.
   * Quality: más audio por frase, más contexto, cola un poco más permisiva.
   */
  latencyMode: LatencyMode
  /** Leer en voz alta la traducción (chrome.tts). */
  speakTranslation: boolean
  /** Bajar el volumen del video original mientras suena el TTS. */
  duckOriginal: boolean
  /** Motor de traducción preferido. */
  translationEngine: TranslationEngineChoice
  /**
   * @deprecated usar translationEngine
   * Intentar TranslateGemma 4B (WebGPU) antes del cascade legacy.
   */
  preferTranslateGemma: boolean
  /**
   * @deprecated usar translationEngine
   * Tamaño de modelo de traducción local.
   */
  translationModelSize: TranslationModelSize
  style: SubtitleStyle
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontScale: 1,
  textColor: "#ffffff",
  backgroundColor: "#000000",
  backgroundOpacity: 0.55,
}

export const DEFAULT_SETTINGS: Settings = {
  sourceLang: "en",
  targetLang: "es",
  model: "tiny",
  dual: false,
  debugLatency: false,
  latencyMode: "live",
  speakTranslation: false,
  duckOriginal: true,
  translationEngine: "auto",
  preferTranslateGemma: true,
  translationModelSize: "4b",
  style: DEFAULT_SUBTITLE_STYLE,
}

export type StatusPhase =
  | "idle"
  | "starting"
  | "downloading"
  | "loading"
  | "listening"
  | "transcribing"
  | "error"

export type StatusMessage = {
  target: string
  type: "status"
  phase: StatusPhase
  detail?: string
  /** 0..1 para descargas de modelos */
  progress?: number
}

/** Ciclo de vida de un subtítulo actualizable in-place. */
export type CueStatus =
  | "transcript_pending"
  | "transcript_confirmed"
  | "translation_pending"
  | "translation_confirmed"

/**
 * Segmentación lingüística (independiente del estado de traducción).
 * PROVISIONAL → UI solamente; FINAL → UI + TTS.
 */
export type CueLifecycle = "PROVISIONAL" | "FINAL"

/** Timestamps absolutos (Date.now) para depurar latencia entre contextos. */
export type CueLatencyMetrics = {
  /** Primera voz del fragmento actual. */
  audioCapturedAt: number
  /** Cierre del chunk (enqueue a ASR). */
  chunkCreatedAt?: number
  asrStartedAt?: number
  asrFinishedAt?: number
  translationStartedAt?: number
  translationFinishedAt?: number
  /** Primer render del texto original en el overlay. */
  firstRenderedAt?: number
  /** @deprecated alias de firstRenderedAt */
  firstTextRenderedAt?: number
  /** Momento en que la traducción quedó visible. */
  translationRenderedAt?: number
  /** Cue marcado isFinal / traducción confirmada. */
  finalCueAt?: number
  /** @deprecated alias de finalCueAt */
  finalAt?: number
  renderedAt?: number
  /** Deltas derivados (ms). */
  audioToChunkMs?: number
  queueWaitMs?: number
  asrLatencyMs?: number
  translationLatencyMs?: number
  firstTextLatencyMs?: number
  totalLatencyMs?: number
  /** Latencias percibidas (ms), rellenadas en content/popup. */
  timeToFirstText?: number
  timeToTranslation?: number
  timeToFinalCue?: number
  /** Motor de traducción activo en este cue. */
  translationEngine?: string
  modelLoadDuration?: number | null
  translationDuration?: number | null
  translationQueueWait?: number | null
  cueFinalizationDuration?: number | null
  boundaryReason?: string
  boundaryConfidence?: number
}

export type CueMessage = {
  target?: string
  type: "cue"
  /** Identificador estable para upsert en el overlay (mismo cue se actualiza). */
  cueId: string
  status: CueStatus
  original: string
  translated: string | null
  /**
   * Parte ya confirmada del original (sin el delta reciente).
   * Si falta, el overlay usa `original` completo.
   */
  confirmedText?: string
  /** Extensión nueva a resaltar (p. ej. en amarillo). */
  deltaText?: string
  /** duración del audio del fragmento, en segundos */
  seconds: number
  /** 0..1 — estabilidad de la hipótesis ASR. */
  stabilityScore?: number
  /** true cuando el subtítulo se considera definitivo. */
  isFinal?: boolean
  /** PROVISIONAL | FINAL — TTS solo en FINAL. */
  lifecycle?: CueLifecycle
  translationBackend?: TranslationBackendInfo | null
  metrics?: CueLatencyMetrics
}

export type TranslationBackendId =
  | "chrome-translator"
  | "marian"
  | "nllb"
  | "translategemma"

/** Traductor activo en la sesión en curso (para mostrar en el popup). */
export type TranslationBackendInfo = {
  id: TranslationBackendId
  /** Nombre legible para el usuario. */
  label: string
  /** Identificador corto del modelo cuando aplica (p. ej. en-es, distilled-600M). */
  model?: string
}

export type SessionState = {
  active: boolean
  tabId?: number
  settings?: Settings
  status?: { phase: StatusPhase; detail?: string; progress?: number }
  translationBackend?: TranslationBackendInfo | null
}
