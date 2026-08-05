/**
 * Glosario de etiquetas de sonido y limpieza de artefactos Marian/NLLB.
 * Adaptado de src/scripts/translation.ts para el path en vivo.
 */

const BRACKETED_SOUND_TRANSLATIONS: Record<string, Record<string, string>> = {
  es: {
    APPLAUSE: "APLAUSOS",
    CLAPPING: "APLAUSOS",
    LAUGHTER: "RISAS",
    LAUGHING: "RISAS",
    MUSIC: "MUSICA",
    CHEERING: "VITORES",
    SILENCE: "SILENCIO",
    NOISE: "RUIDO",
    "BACKGROUND NOISE": "RUIDO DE FONDO",
    INAUDIBLE: "INAUDIBLE",
    SIGH: "SUSPIRO",
    COUGH: "TOS",
    COUGHING: "TOS",
    CRYING: "LLANTO",
    GASP: "JADEO",
    BEEP: "PITIDO",
    WHISTLE: "SILBIDO",
    AUDIENCE: "PUBLICO",
  },
}

const BRACKETED_CUE_PATTERN = /\[([^\[\]]{1,80})\]/g
const NOISY_PUNCTUATION_RUN = /(?:[.!?…]\s*){4,}/gu
const NOISY_TRANSLATION_TAIL = /[.!?…](?:\s*[.!?…¡¿,;:>]){3,}.*$/u
const REPEATED_TRAILING_SYMBOLS =
  /(?:[^\p{L}\p{N}\s])(?:\s*[^\p{L}\p{N}\s]){3,}\s*$/u

function soundCueKey(label: string) {
  return label
    .trim()
    .replace(/^[\s.!?¡¿…]+|[\s.!?¡¿…]+$/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase()
}

function terminalPunctuationForSource(sourceText = "", fallbackRun = "") {
  const source = sourceText.trim()
  if (/[?？]\s*$/.test(source)) return "?"
  if (/[!！]\s*$/.test(source)) return "!"
  if (/[.…]\s*$/.test(source)) return "."
  if (fallbackRun.includes("?")) return "?"
  if (fallbackRun.includes("!")) return "!"
  return "."
}

function translatedSoundCueLabels(text: string, targetLang: string) {
  const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
  if (!glossary) return []

  const labels: string[] = []
  for (const match of text.matchAll(BRACKETED_CUE_PATTERN)) {
    const translated = glossary[soundCueKey(match[1])]
    if (translated) labels.push(translated)
  }
  return labels
}

export class GlossaryManager {
  /** Traduce etiquetas [SOUND] conocidas al idioma destino. */
  translateBracketedSoundCues(text: string, targetLang: string): string {
    const glossary = BRACKETED_SOUND_TRANSLATIONS[targetLang]
    if (!glossary) return text

    return text.replace(BRACKETED_CUE_PATTERN, (match, label) => {
      const translated = glossary[soundCueKey(label)]
      return translated ? `[${translated}]` : match
    })
  }

  /** Fuerza que las etiquetas del original aparezcan traducidas en el output. */
  enforceBracketedSoundCues(
    translatedText: string,
    sourceText: string,
    targetLang: string,
  ): string {
    const expectedLabels = translatedSoundCueLabels(sourceText, targetLang)
    if (!expectedLabels.length) return translatedText

    let labelIndex = 0
    const text = translatedText.replace(BRACKETED_CUE_PATTERN, (match) => {
      const label = expectedLabels[labelIndex]
      if (!label) return match
      labelIndex += 1
      return `[${label}]`
    })

    if (labelIndex >= expectedLabels.length) return text

    const missingLabels = expectedLabels
      .slice(labelIndex)
      .map((label) => `[${label}]`)
      .join(" ")
    return `${text.trimEnd()} ${missingLabels}`.trim()
  }

  /** Quita puntuación repetida / colas basura típicas de Marian. */
  cleanTranslationArtifacts(text: string, sourceText = ""): string {
    let cleaned = String(text || "").trim()
    let previous = ""
    while (cleaned && cleaned !== previous) {
      previous = cleaned
      cleaned = cleaned
        .replace(NOISY_TRANSLATION_TAIL, (tail, offset, fullText) => {
          const prefix = fullText.slice(0, offset).trimEnd()
          if (!prefix) return ""
          if (/[.!?…]\s*$/.test(prefix)) return prefix
          return `${prefix}${terminalPunctuationForSource(sourceText, tail)}`
        })
        .replace(NOISY_PUNCTUATION_RUN, (run) => {
          return terminalPunctuationForSource(sourceText, run)
        })
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/([¿¡])\s+/g, "$1")
        .replace(REPEATED_TRAILING_SYMBOLS, "")
        .trimEnd()
    }
    return cleaned
  }

  /** Pipeline post-traducción: glosario + limpieza. */
  polish(translated: string, sourceText: string, targetLang: string): string {
    const withSounds = this.translateBracketedSoundCues(translated, targetLang)
    const enforced = this.enforceBracketedSoundCues(
      withSounds,
      sourceText,
      targetLang,
    )
    return this.cleanTranslationArtifacts(enforced, sourceText)
  }
}

export const glossaryManager = new GlossaryManager()
