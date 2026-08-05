/**
 * Constantes de troceado adaptativo de audio.
 * Guía: extension/README.md → "Ajustar la latencia de los subtítulos".
 *
 * MIN no es fijo: frases cortas con silencio claro cierran antes (~1.5–1.8 s);
 * habla continua exige un poco más (~2.0 s) para no cortar.
 */

import type { LatencyMode } from "../shared/types.ts"

/** Sample rate enviado a Whisper. */
export const TARGET_SR = 16_000

/** Mínimo absoluto con pausa clara (frase corta tipo “Hola, ¿cómo estás?”). */
export const MIN_CHUNK_SECONDS_FLOOR = 1.5

/** Mínimo por defecto (conversación normal). */
export const MIN_CHUNK_SECONDS = 1.8

/** Mínimo cuando la voz es continua / rápida (poca pausa interna). */
export const MIN_CHUNK_SECONDS_BUSY = 2.0

/** Máximo de audio acumulado si no hay pausas. */
export const MAX_CHUNK_SECONDS = 4.0

/** Silencio continuo que marca fin de frase (tras MIN). ~400 ms. */
export const SILENCE_HOLD_SECONDS = 0.4

/** Silencio “claro” para permitir el floor de 1.5 s. */
export const SILENCE_HOLD_CLEAR_SECONDS = 0.45

/** RMS por debajo del cual se considera silencio. */
export const SILENCE_RMS = 0.006

/**
 * Tras detectar pausa natural, conservar este margen de audio al final
 * del chunk (reduce cortes de palabra). En MAX hard-cut no se aplica.
 */
export const CHUNK_HANGOVER_SECONDS = 0.2

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
  maxPendingAsr: number
  contextCues: number
}

export function chunkProfileFor(mode: LatencyMode = "live"): ChunkProfile {
  if (mode === "quality") {
    return {
      minFloor: 2.0,
      minDefault: 2.5,
      minBusy: 3.0,
      maxChunk: 5.0,
      silenceHold: 0.5,
      silenceClear: 0.55,
      hangover: 0.22,
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
    maxPendingAsr: MAX_PENDING_ASR,
    contextCues: TRANSLATION_CONTEXT_CUES,
  }
}

/**
 * MIN efectivo para cerrar por pausa natural.
 * - Pausa clara + ya hay ≥ floor → permitir cierre temprano.
 * - Habla densa (poca fracción de silencio) → exigir minBusy.
 * - Caso normal → minDefault (~1.8 s en live).
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
  if (trailingSilence >= profile.silenceClear) {
    return profile.minFloor
  }
  // Habla rápida/continua: poco silencio acumulado dentro del fragmento.
  if (silenceRatio < 0.12) {
    return profile.minBusy
  }
  return profile.minDefault
}
