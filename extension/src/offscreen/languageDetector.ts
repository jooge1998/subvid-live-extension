/**
 * Detector de idioma con caché temporal.
 * Evita llamar chrome.i18n.detectLanguage en cada frase corta.
 */

import { LANGS } from "../shared/languages.ts"

export type LanguageCacheEntry = {
  language: string
  confidence: number
  timestamp: number
}

const HIGH_CONFIDENCE = 0.8
/** Incluso una intervención corta ("Hello", "Danke") debe poder arrancar. */
const MIN_WORDS_TO_DETECT = 1
const MIN_WORDS_TO_SWITCH = 5
const MIN_FIRST_CONFIDENCE = 0.2
/** TTL del caché: si hay detección reciente estable, reutilizar. */
const CACHE_TTL_MS = 45_000
const MAX_SAMPLE_CHARS = 700

function wordCount(text: string) {
  const t = text.trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

function normalizeLangCode(raw: string): string | null {
  const code = raw.toLowerCase().split("-")[0]
  if (code && code in LANGS) return code
  return null
}

/** Escrituras inequívocas: evita depender de i18n para estos idiomas. */
function detectByScript(text: string): string | null {
  if (/[\u3040-\u30ff]/u.test(text)) return "ja"
  if (/[\uac00-\ud7af]/u.test(text)) return "ko"
  if (/[\u4e00-\u9fff]/u.test(text)) return "zh"
  if (/[\u0600-\u06ff]/u.test(text)) return "ar"
  if (/[\u0900-\u097f]/u.test(text)) return "hi"
  if (/[\u0400-\u04ff]/u.test(text)) return "ru"
  return null
}

export class LanguageDetector {
  private cache: LanguageCacheEntry | null = null
  private sample = ""
  private lastSamplePart = ""

  reset() {
    this.cache = null
    this.sample = ""
    this.lastSamplePart = ""
  }

  getCached(): LanguageCacheEntry | null {
    if (!this.cache) return null
    if (performance.now() - this.cache.timestamp > CACHE_TTL_MS) return null
    return this.cache
  }

  /**
   * Devuelve el idioma efectivo para la sesión.
   * Solo cambia el caché con confianza alta y texto suficientemente largo.
   */
  async resolve(text: string): Promise<string | null> {
    const cached = this.getCached()
    const incoming = text.trim()
    if (incoming && incoming !== this.lastSamplePart) {
      this.sample = `${this.sample} ${incoming}`.trim().slice(-MAX_SAMPLE_CHARS)
      this.lastSamplePart = incoming
    }
    const sample = this.sample || incoming
    const words = wordCount(sample)

    const scriptLanguage = detectByScript(sample)
    if (scriptLanguage) {
      this.cache = {
        language: scriptLanguage,
        confidence: 0.99,
        timestamp: performance.now(),
      }
      return scriptLanguage
    }

    // Acumular frases cortas en vez de descartarlas para siempre.
    if (words < MIN_WORDS_TO_DETECT) {
      return cached?.language ?? null
    }

    // Caché reciente con alta confianza: no re-detectar cada cue.
    if (
      cached &&
      cached.confidence >= HIGH_CONFIDENCE &&
      performance.now() - cached.timestamp < CACHE_TTL_MS
    ) {
      // Re-detectar de vez en cuando (cada ~TTL/2) con texto largo.
      if (performance.now() - cached.timestamp < CACHE_TTL_MS / 2) {
        return cached.language
      }
    }

    try {
      const result = await chrome.i18n.detectLanguage(sample)
      const top = result?.languages?.[0]
      if (!top?.language || top.language === "und") {
        return cached?.language ?? null
      }
      const code = normalizeLangCode(top.language)
      if (!code) return cached?.language ?? null

      // Chrome percentage is 0–100.
      const confidence =
        typeof top.percentage === "number"
          ? Math.min(1, Math.max(0, top.percentage / 100))
          : 0.5

      if (!cached) {
        // Chrome suele repartir porcentajes entre idiomas latinos. Aceptar el
        // candidato superior con muestra acumulada evita dejar source="auto".
        const second = result?.languages?.[1]
        const secondConfidence =
          typeof second?.percentage === "number"
            ? Math.min(1, Math.max(0, second.percentage / 100))
            : 0
        const hasUsefulLead = confidence - secondConfidence >= 0.08
        if (
          confidence >= MIN_FIRST_CONFIDENCE &&
          (hasUsefulLead || words >= MIN_WORDS_TO_SWITCH)
        ) {
          this.cache = {
            language: code,
            confidence,
            timestamp: performance.now(),
          }
          return code
        }
        return null
      }

      // Cambiar idioma solo con confianza alta y distinto del actual.
      if (
        code !== cached.language &&
        confidence >= HIGH_CONFIDENCE &&
        words >= MIN_WORDS_TO_SWITCH
      ) {
        this.cache = {
          language: code,
          confidence,
          timestamp: performance.now(),
        }
        return code
      }

      // Misma lengua: refrescar timestamp/confianza.
      if (code === cached.language) {
        this.cache = {
          language: code,
          confidence: Math.max(cached.confidence, confidence),
          timestamp: performance.now(),
        }
        return code
      }

      // Detección dudosa distinta: mantener caché.
      return cached.language
    } catch {
      return cached?.language ?? null
    }
  }
}

export const languageDetector = new LanguageDetector()
