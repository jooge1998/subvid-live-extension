/**
 * Combina señales de audio / heurística / TranslateGemma para PROVISIONAL|FINAL.
 * Gemma NO reemplaza VAD ni sentenceBoundaryDetector: solo desempata ambigüedad.
 */

import {
  MAX_PENDING_FRAGMENT_CHARS,
  MAX_PENDING_FRAGMENT_CUES,
  MAX_PENDING_FRAGMENT_MS,
} from "./pendingFragment.ts"
import type { GemmaCompletionReason } from "./gemmaStructuredOutput.ts"

/** Umbral mínimo para aceptar gemmaComplete=true como cierre. */
export const GEMMA_COMPLETION_CONFIDENCE = 0.7

/** Por debajo de esto + voz reciente → audio aún hablando (no cortar por Gemma). */
export const ACTIVE_SPEECH_SILENCE_SECONDS = 0.12

/** Pausa razonable para puntuación / oportunidad de cierre. */
export const SOFT_CLOSE_SILENCE_SECONDS = 0.2

export type BoundaryDecisionStatus = "PROVISIONAL" | "FINAL"

export type BoundaryDecisionReason =
  | "max_pending_limit"
  | "silence"
  | "punctuation"
  | "heuristic"
  | "gemma_complete"
  | "gemma_continuation"
  | "audio_continuing"
  | "waiting"
  | "unknown"

export type BoundaryDecisionInput = {
  text: string
  silenceDuration: number
  isWhisperStable?: boolean
  whisperPunctuation?: boolean
  /** Resultado del detector heurístico (sentenceBoundary / pendingFragment). */
  heuristicComplete?: boolean
  heuristicReason?: string
  heuristicConfidence?: number
  /** null = Gemma no disponible / no devolvió señal. */
  gemmaComplete?: boolean | null
  gemmaConfidence?: number
  gemmaReason?: GemmaCompletionReason | string | null
  pendingFragmentAgeMs?: number
  pendingFragmentChars?: number
  pendingFragmentCues?: number
  flushedByLimit?: boolean
  /** true si VAD indica habla activa sin pausa. */
  audioLikelyContinuing?: boolean
  silenceClearSeconds?: number
}

export type BoundaryDecision = {
  status: BoundaryDecisionStatus
  confidence: number
  reason: BoundaryDecisionReason
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?…]["'»)]*\s*$/u.test((text || "").trim())
}

/**
 * Resuelve PROVISIONAL vs FINAL con prioridad por niveles (ver spec).
 */
export function resolveBoundaryDecision(
  input: BoundaryDecisionInput,
): BoundaryDecision {
  const text = (input.text || "").trim()
  const silence = Math.max(0, input.silenceDuration || 0)
  const silenceClear = input.silenceClearSeconds ?? 0.5
  const softSilence = Math.min(SOFT_CLOSE_SILENCE_SECONDS, silenceClear)
  const punct =
    input.whisperPunctuation === true || hasTerminalPunctuation(text)
  const age = input.pendingFragmentAgeMs ?? 0
  const chars = input.pendingFragmentChars ?? text.length
  const cues = input.pendingFragmentCues ?? 0
  const gemmaConf = input.gemmaConfidence ?? 0
  const audioContinuing =
    input.audioLikelyContinuing === true ||
    silence < ACTIVE_SPEECH_SILENCE_SECONDS

  // --- Nivel 1: límites duros ---
  if (
    input.flushedByLimit ||
    age >= MAX_PENDING_FRAGMENT_MS ||
    chars >= MAX_PENDING_FRAGMENT_CHARS ||
    (cues > 0 && cues >= MAX_PENDING_FRAGMENT_CUES)
  ) {
    return {
      status: "FINAL",
      confidence: 0.95,
      reason: "max_pending_limit",
    }
  }

  // --- Nivel 2: audio terminó (silencio claro + estable) ---
  // No forzar FINAL en fragmentos gramaticales obvios ("I think") solo por silencio:
  // eso lo resuelven Gemma (nivel 4/5) o max_pending (nivel 1).
  const heuristicSaysFragment =
    input.heuristicComplete === false &&
    /fragment|continuation|whisper_unstable|waiting/i.test(
      String(input.heuristicReason || ""),
    )
  if (
    silence >= silenceClear &&
    input.isWhisperStable !== false &&
    !heuristicSaysFragment
  ) {
    return {
      status: "FINAL",
      confidence: 0.88,
      reason: "silence",
    }
  }

  // --- Nivel 3: puntuación terminal + pausa razonable ---
  if (punct && silence >= softSilence) {
    return {
      status: "FINAL",
      confidence: 0.9,
      reason: "punctuation",
    }
  }

  // Heurística ya completa + oportunidad de cierre (no en habla activa)
  if (input.heuristicComplete === true && !audioContinuing) {
    return {
      status: "FINAL",
      confidence: input.heuristicConfidence ?? 0.8,
      reason: "heuristic",
    }
  }

  // --- Nivel 4: Gemma confirma completitud ---
  if (
    input.gemmaComplete === true &&
    gemmaConf >= GEMMA_COMPLETION_CONFIDENCE
  ) {
    if (audioContinuing) {
      return {
        status: "PROVISIONAL",
        confidence: 0.7,
        reason: "audio_continuing",
      }
    }
    return {
      status: "FINAL",
      confidence: gemmaConf,
      reason: "gemma_complete",
    }
  }

  // --- Nivel 5: Gemma indica continuación (no espera infinita: nivel 1 manda) ---
  if (input.gemmaComplete === false) {
    return {
      status: "PROVISIONAL",
      confidence: Math.max(gemmaConf, 0.6),
      reason: "gemma_continuation",
    }
  }

  // Sin señal Gemma: respetar heurística si hay oportunidad de cierre
  if (input.heuristicComplete === true) {
    if (audioContinuing) {
      return {
        status: "PROVISIONAL",
        confidence: 0.55,
        reason: "audio_continuing",
      }
    }
    return {
      status: "FINAL",
      confidence: input.heuristicConfidence ?? 0.75,
      reason: "heuristic",
    }
  }

  return {
    status: "PROVISIONAL",
    confidence: 0.5,
    reason: "waiting",
  }
}
