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

export type SessionState = {
  active: boolean
  tabId?: number
  settings?: Settings
  status?: { phase: StatusPhase; detail?: string; progress?: number }
}
