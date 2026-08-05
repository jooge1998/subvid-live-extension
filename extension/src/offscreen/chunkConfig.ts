/**
 * Constantes de troceado adaptativo de audio.
 * Guía de ajuste: extension/README.md → "Ajustar la latencia de los subtítulos".
 *
 * Reglas:
 * - Tras MIN, un silencio ≥ SILENCE_HOLD cierra el fragmento.
 * - Nunca superar MAX (se flushea sí o sí).
 * - HANGOVER retiene un poco de audio tras silencio para no cortar la última sílaba.
 */

/** Sample rate enviado a Whisper. */
export const TARGET_SR = 16_000

/** Duración mínima de audio con voz antes de poder cerrar por pausa. */
export const MIN_CHUNK_SECONDS = 1.5

/** Máximo de audio acumulado si no hay pausas. */
export const MAX_CHUNK_SECONDS = 4

/** Silencio continuo que marca fin de frase (tras MIN). */
export const SILENCE_HOLD_SECONDS = 0.4

/** RMS por debajo del cual se considera silencio. */
export const SILENCE_RMS = 0.006

/**
 * Tras detectar pausa natural, conservar este margen de audio al final
 * del chunk (reduce cortes de palabra). En MAX hard-cut no se aplica.
 */
export const CHUNK_HANGOVER_SECONDS = 0.2

/** Cola ASR: si hay retraso, se descartan los más antiguos. */
export const MAX_PENDING_ASR = 2

/** Cola de traducción independiente (no bloquea captura ni ASR). */
export const MAX_PENDING_TRANSLATION = 3

/** Cuántos cues originales previos se pasan como contexto al traductor. */
export const TRANSLATION_CONTEXT_CUES = 3
