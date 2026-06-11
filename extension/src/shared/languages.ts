// Misma tabla de modelos que usa subvid.app (src/scripts/languages.ts),
// adaptada para la extensión.

export const ASR_MODELS: Record<string, string> = {
  tiny: "Xenova/whisper-tiny",
  base: "Xenova/whisper-base",
  small: "Xenova/whisper-small",
}

export const NLLB_MODEL = "Xenova/nllb-200-distilled-600M"

export const MARIAN_TRANSLATION_MODELS: Record<string, string> = {
  "en:es": "Xenova/opus-mt-en-es",
  "es:en": "Xenova/opus-mt-es-en",
  "en:fr": "Xenova/opus-mt-en-fr",
  "fr:en": "Xenova/opus-mt-fr-en",
  "en:de": "Xenova/opus-mt-en-de",
  "de:en": "Xenova/opus-mt-de-en",
  "en:pt": "Xenova/opus-mt-en-pt",
  "pt:en": "Xenova/opus-mt-pt-en",
  "en:it": "Xenova/opus-mt-en-it",
  "it:en": "Xenova/opus-mt-it-en",
  "en:nl": "Xenova/opus-mt-en-nl",
  "nl:en": "Xenova/opus-mt-nl-en",
  "en:ru": "Xenova/opus-mt-en-ru",
  "ru:en": "Xenova/opus-mt-ru-en",
}

export const LANGS: Record<string, { label: string; nllb: string }> = {
  en: { label: "Inglés", nllb: "eng_Latn" },
  es: { label: "Español", nllb: "spa_Latn" },
  fr: { label: "Francés", nllb: "fra_Latn" },
  de: { label: "Alemán", nllb: "deu_Latn" },
  pt: { label: "Portugués", nllb: "por_Latn" },
  it: { label: "Italiano", nllb: "ita_Latn" },
  nl: { label: "Neerlandés", nllb: "nld_Latn" },
  ru: { label: "Ruso", nllb: "rus_Cyrl" },
  ja: { label: "Japonés", nllb: "jpn_Jpan" },
  ko: { label: "Coreano", nllb: "kor_Hang" },
  zh: { label: "Chino", nllb: "zho_Hans" },
  ar: { label: "Árabe", nllb: "arb_Arab" },
  hi: { label: "Hindi", nllb: "hin_Deva" },
  pl: { label: "Polaco", nllb: "pol_Latn" },
  tr: { label: "Turco", nllb: "tur_Latn" },
}
