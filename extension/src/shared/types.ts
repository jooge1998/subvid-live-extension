export type SubtitleStyle = {
  /** Multiplicador sobre el tamaño automático según el ancho del video. */
  fontScale: number
  textColor: string
  backgroundColor: string
  /** 0..1 */
  backgroundOpacity: number
}

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

/** Timestamps absolutos (performance.now / Date.now) para depurar latencia. */
export type CueLatencyMetrics = {
  audioCapturedAt: number
  asrStartedAt?: number
  asrFinishedAt?: number
  translationStartedAt?: number
  translationFinishedAt?: number
  renderedAt?: number
}

export type CueMessage = {
  target?: string
  type: "cue"
  /** Identificador estable para upsert en el overlay (mismo cue se actualiza). */
  cueId: string
  status: CueStatus
  original: string
  translated: string | null
  /** duración del audio del fragmento, en segundos */
  seconds: number
  translationBackend?: TranslationBackendInfo | null
  metrics?: CueLatencyMetrics
}

export type TranslationBackendId = "chrome-translator" | "marian" | "nllb"

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
