/**
 * Opciones de motor de traducción para el popup (cualquier navegador).
 */

import type { TranslationEngineChoice } from "./types.ts"

export type TranslationEngineOption = {
  id: TranslationEngineChoice
  label: string
}

export const TRANSLATION_ENGINE_OPTIONS: TranslationEngineOption[] = [
  {
    id: "auto",
    label:
      "Auto cascade (Gemma 4B → Chrome → Marian → NLLB · recomienda WebGPU)",
  },
  {
    id: "translategemma",
    label:
      "TranslateGemma 4B (alta calidad · ~2.9 GB · WebGPU obligatorio · más lento al cargar)",
  },
  {
    id: "chrome-translator",
    label:
      "Chrome Translator (muy rápido · integrado · solo Chrome/Edge con modelo descargado)",
  },
  {
    id: "marian",
    label:
      "MarianMT (buena calidad · ~300 MB · solo pares frecuentes en↔es/fr/de…)",
  },
  {
    id: "nllb",
    label:
      "NLLB-200 distilled (multilingüe · ~600 MB · más lento · más idiomas)",
  },
]

export function normalizeTranslationEngine(
  value: unknown,
  legacy?: { preferTranslateGemma?: boolean; translationModelSize?: string },
): TranslationEngineChoice {
  const allowed: TranslationEngineChoice[] = [
    "auto",
    "translategemma",
    "chrome-translator",
    "marian",
    "nllb",
  ]
  if (typeof value === "string" && allowed.includes(value as TranslationEngineChoice)) {
    return value as TranslationEngineChoice
  }
  // Migración desde flags previos.
  if (legacy?.translationModelSize === "fallback") return "auto"
  if (legacy?.preferTranslateGemma === false) return "auto"
  if (legacy?.preferTranslateGemma === true) return "auto"
  return "auto"
}
