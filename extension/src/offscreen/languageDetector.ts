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

const HIGH_CONFIDENCE = 0.85
/** Frases con pocas palabras no deben cambiar el idioma de sesión. */
const MIN_WORDS_TO_SWITCH = 4
/** TTL del caché: si hay detección reciente estable, reutilizar. */
const CACHE_TTL_MS = 45_000

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

export class LanguageDetector {
  private cache: LanguageCacheEntry | null = null

  reset() {
    this.cache = null
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
    const words = wordCount(text)

    // Frases cortas: no detectar de nuevo; usar caché si existe.
    if (words < MIN_WORDS_TO_SWITCH) {
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
      const result = await chrome.i18n.detectLanguage(text)
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
        // Primera detección: aceptar umbral algo más bajo para arrancar.
        if (confidence >= 0.6) {
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
