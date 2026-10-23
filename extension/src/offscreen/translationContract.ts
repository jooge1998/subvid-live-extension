/**
 * Contrato común para motores de traducción intercambiables.
 * El pipeline en vivo sigue usando TranslationEngine; este contrato
 * es el que comparten Hy-MT2, el benchmark y cualquier adaptador.
 */

export type TranslationRequest = {
  text: string
  sourceLanguage: string
  targetLanguage: string
  /** Cues previos. Contexto, no texto a retraducir. */
  context?: string[]
  /** Pares origen → traducción preferida. */
  terminology?: Record<string, string>
  signal?: AbortSignal
}

export type TranslationResult = {
  translatedText: string
  provider: string
  latencyMs?: number
  metadata?: Record<string, unknown>
}

export interface TranslationProvider {
  translate(request: TranslationRequest): Promise<TranslationResult>
}
