/**
 * Constantes de troceado adaptativo de audio.
 * Guía: extension/README.md → "Ajustar la latencia de los subtítulos".
 *
 * Prioridad: no cortar ideas a mitad de frase.
 * Los silencios breves (comas / respiración) NO deben cerrar el fragmento;
 * solo pausas claras de fin de idea.
 */

import type { LatencyMode } from "../shared/types.ts"

/** Sample rate enviado a Whisper. */
export const TARGET_SR = 16_000

/** Mínimo absoluto con pausa muy clara (frase corta). */
export const MIN_CHUNK_SECONDS_FLOOR = 1.8

/** Mínimo por defecto (conversación normal). */
export const MIN_CHUNK_SECONDS = 2.4

/** Mínimo cuando la voz es continua / rápida. */
export const MIN_CHUNK_SECONDS_BUSY = 3.0

/** Máximo de audio acumulado si no hay pausas. */
export const MAX_CHUNK_SECONDS = 6.0

/**
 * Silencio continuo para fin de frase.
 * ~0.6 s: las pausas de coma/respiración (~0.2–0.45 s) no cortan la idea.
 */
export const SILENCE_HOLD_SECONDS = 0.6

/** Silencio más largo para permitir el floor mínimo. */
export const SILENCE_HOLD_CLEAR_SECONDS = 0.75

/** RMS por debajo del cual se considera silencio. */
export const SILENCE_RMS = 0.006

/**
 * Margen tras pausa para no cortar la última sílaba.
 */
export const CHUNK_HANGOVER_SECONDS = 0.3

/**
 * Audio del final del chunk que se reutiliza al inicio del siguiente.
 * Ayuda a Whisper a no “empezar a mitad” de una idea tras un corte.
 */
export const CHUNK_OVERLAP_SECONDS = 0.7

/**
 * Cola ASR: 1 = priorizar “en vivo” (descartar atrasados).
 * En modo quality se usa MAX_PENDING_ASR_QUALITY.
 */
export const MAX_PENDING_ASR = 1
export const MAX_PENDING_ASR_QUALITY = 2

/** Cola de traducción independiente (no bloquea captura ni ASR). */
export const MAX_PENDING_TRANSLATION = 3

/** Cuántos cues originales previos se pasan como contexto al traductor. */
export const TRANSLATION_CONTEXT_CUES = 2
export const TRANSLATION_CONTEXT_CUES_QUALITY = 3

/** Perfil de troceado según modo Live / Quality. */
export type ChunkProfile = {
  minFloor: number
  minDefault: number
  minBusy: number
  maxChunk: number
  silenceHold: number
  silenceClear: number
  hangover: number
  overlap: number
  maxPendingAsr: number
  contextCues: number
}

export function chunkProfileFor(mode: LatencyMode = "live"): ChunkProfile {
  if (mode === "quality") {
    return {
      minFloor: 2.2,
      minDefault: 3.0,
      minBusy: 3.5,
      maxChunk: 7.0,
      silenceHold: 0.7,
      silenceClear: 0.85,
      hangover: 0.35,
      overlap: 0.8,
      maxPendingAsr: MAX_PENDING_ASR_QUALITY,
      contextCues: TRANSLATION_CONTEXT_CUES_QUALITY,
    }
  }
  return {
    minFloor: MIN_CHUNK_SECONDS_FLOOR,
    minDefault: MIN_CHUNK_SECONDS,
    minBusy: MIN_CHUNK_SECONDS_BUSY,
    maxChunk: MAX_CHUNK_SECONDS,
    silenceHold: SILENCE_HOLD_SECONDS,
    silenceClear: SILENCE_HOLD_CLEAR_SECONDS,
    hangover: CHUNK_HANGOVER_SECONDS,
    overlap: CHUNK_OVERLAP_SECONDS,
    maxPendingAsr: MAX_PENDING_ASR,
    contextCues: TRANSLATION_CONTEXT_CUES,
  }
}

/**
 * MIN efectivo para cerrar por pausa natural.
 * Solo con silencio claro se permite el floor; si no, se espera más audio.
 */
export function adaptiveMinChunkSeconds(
  profile: ChunkProfile,
  opts: {
    chunkSeconds: number
    trailingSilence: number
    /** 0..1 — fracción del chunk que fue silencio. */
    silenceRatio: number
  },
): number {
  const { trailingSilence, silenceRatio } = opts
  // Pausa muy clara (fin de idea): permitir cierre desde floor.
  if (trailingSilence >= profile.silenceClear) {
    return profile.minFloor
  }
  // Habla densa: exigir más contexto antes de cortar.
  if (silenceRatio < 0.1) {
    return profile.minBusy
  }
  return profile.minDefault
}
