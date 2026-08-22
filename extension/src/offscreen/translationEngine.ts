/**
 * Abstracción de motor de traducción.
 * El pipeline no depende de TranslateGemma ni de Marian directamente.
 */

import type { TranslationBackendInfo } from "../shared/types.ts"

export type TranslationEngineState = "idle" | "loading" | "ready" | "error"

export type TranslationEngineId =
  | "translategemma"
  | "chrome-translator"
  | "marian"
  | "nllb"
  | "legacy-cascade"

export type TranslateEngineInput = {
  text: string
  previousContext: string[]
  sourceLang: string
  targetLang: string
}

/** Señal de completitud lingüística (solo TranslateGemma; null en fallbacks). */
export type TranslationCompleteness = {
  complete: boolean | null
  confidence: number
  reason: string
}

export type TranslateEngineResult = {
  text: string | null
  backend: TranslationBackendInfo | null
  /** Métricas opcionales del intento. */
  translationDurationMs?: number
  modelLoadDurationMs?: number | null
  /**
   * Presente solo si el motor aportó señal (TranslateGemma).
   * Chrome/Marian/NLLB → undefined (no simular).
   */
  completeness?: TranslationCompleteness
}

export type TranslationEngineLoadMetrics = {
  modelLoadStart: number | null
  modelLoadEnd: number | null
  modelLoadDuration: number | null
  translationStart: number | null
  translationEnd: number | null
  translationDuration: number | null
}

export interface TranslationEngine {
  readonly id: TranslationEngineId
  getState(): TranslationEngineState
  getBackend(): TranslationBackendInfo | null
  getLoadMetrics(): TranslationEngineLoadMetrics
  /**
   * Precarga opcional (lazy). No debe bloquear captura/ASR si falla.
   */
  warmUp?(sourceLang: string, targetLang: string): Promise<void>
  translate(input: TranslateEngineInput): Promise<TranslateEngineResult>
  dispose(): void
}

export const emptyLoadMetrics = (): TranslationEngineLoadMetrics => ({
  modelLoadStart: null,
  modelLoadEnd: null,
  modelLoadDuration: null,
  translationStart: null,
  translationEnd: null,
  translationDuration: null,
})
