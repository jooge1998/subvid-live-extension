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

export type CueMessage = {
  target: string
  type: "cue"
  original: string
  translated: string | null
  /** duración del audio del fragmento, en segundos */
  seconds: number
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

// ---------------------------------------------------------------------------
// Detección de streams de video (webRequest)
// ---------------------------------------------------------------------------

/** Solo se almacenan streams "principales": MP4 completos y manifiestos. */
export type StreamKind = "hls" | "dash" | "video"

export type HlsVariant = {
  url: string
  /** "1280x720" si el manifiesto lo declara. */
  resolution?: string
  /** bits por segundo declarados en el manifiesto. */
  bandwidth?: number
}

export type CapturedStream = {
  id: string
  tabId: number
  /** URL ya normalizada (sin rangos bytestart/byteend de FB). */
  url: string
  kind: StreamKind
  seenAt: number
  /** Dominio de origen del recurso (no de la página). */
  domain: string
  contentType?: string
  /** Tamaño total reportado (Content-Length o total de Content-Range). */
  sizeBytes?: number
  /** "1280x720" cuando se puede deducir (manifiesto o ruta de la URL). */
  resolution?: string
  /** Cómo se detectó: extensión, Content-Type, manifiesto… */
  detectedBy: string
  /** HLS: true si es una master playlist con variantes. */
  isMaster?: boolean
  /** HLS master: variantes ordenadas de mejor a peor calidad. */
  variants?: HlsVariant[]
  /** HLS master: playlist del audio separado (X usa pistas independientes). */
  audioPlaylistUrl?: string
  /** DASH: resumen del manifiesto. */
  dashInfo?: {
    videoTracks: number
    audioTracks: number
    maxResolution?: string
  }
}
