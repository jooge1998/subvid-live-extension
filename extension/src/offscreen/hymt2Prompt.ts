/**
 * Prompt oficial de Hy-MT2 (tarjeta tencent/Hy-MT2-1.8B-GGUF).
 * El modelo no usa system prompt. El user message sigue las plantillas
 * Default, Terminology o Background Information.
 */

import type { TranslationRequest } from "./translationContract.ts"

/** Nombres en inglés: la plantilla inglesa de Hy-MT2 los exige así. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  ja: "Japanese",
  zh: "Chinese",
  fr: "French",
  pt: "Portuguese",
  de: "German",
  ko: "Korean",
  ru: "Russian",
  ar: "Arabic",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  hi: "Hindi",
}

/**
 * Parámetros de inferencia recomendados por Tencent para 1.8B y 7B.
 * No hay system prompt por defecto.
 */
export const HYMT2_SAMPLING = {
  temperature: 0.7,
  top_p: 0.6,
  top_k: 20,
  repeat_penalty: 1.05,
  max_tokens: 4096,
} as const

export function hymt2LanguageName(code: string): string {
  const key = code.trim().toLowerCase()
  return LANGUAGE_NAMES[key] || code.trim() || "English"
}

function contextLines(context: string[] | undefined): string[] {
  return (context || []).map((line) => line.trim()).filter(Boolean).slice(-5)
}

function terminologyLines(
  terminology: Record<string, string> | undefined,
): string[] {
  if (!terminology) return []
  const lines: string[] = []
  for (const [source, target] of Object.entries(terminology)) {
    const from = source.trim()
    const to = String(target || "").trim()
    if (!from || !to) continue
    lines.push(`${from} translates to ${to}`)
  }
  return lines
}

/**
 * Construye solo el mensaje de usuario.
 * El contexto y la terminología no se piden como texto a traducir.
 */
export function buildHyMt2UserPrompt(
  request: Pick<
    TranslationRequest,
    "text" | "targetLanguage" | "context" | "terminology"
  >,
): string {
  const text = request.text.trim()
  const target = hymt2LanguageName(request.targetLanguage)
  const context = contextLines(request.context)
  const terms = terminologyLines(request.terminology)

  if (!context.length && !terms.length) {
    return `Translate the following text into ${target}. Note that you should only output the translated result without any additional explanation:\n${text}`
  }

  if (!context.length) {
    return [
      "Reference the following translations:",
      ...terms,
      `Translate the following text into ${target}. Note that you must ONLY output the translated result without any additional explanation:`,
      text,
    ].join("\n")
  }

  const background = [
    "Previous subtitle context. Use it only to keep terminology, pronouns, names and references consistent. Do not translate these lines again:",
    ...context.map((line, index) => `${index + 1}. ${line}`),
  ]
  if (terms.length) {
    background.push("Terminology:", ...terms)
  }

  return [
    "[Background Information]",
    background.join("\n"),
    `Please translate the following text into ${target}, taking the provided background information into consideration.`,
    "[Source Text]",
    text,
  ].join("\n")
}
