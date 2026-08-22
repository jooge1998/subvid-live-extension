/**
 * Mapeo de códigos de idioma SubVid → locales BCP-47 para chrome.tts.
 */

const TTS_LOCALES: Record<string, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  it: "it-IT",
  nl: "nl-NL",
  ru: "ru-RU",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  ar: "ar-SA",
  hi: "hi-IN",
  pl: "pl-PL",
  tr: "tr-TR",
}

export function ttsLocaleForLang(code: string | undefined): string {
  if (!code || code === "none" || code === "auto") return "en-US"
  return TTS_LOCALES[code] || code
}

/**
 * Encola la traducción detrás del utterance actual.
 * Importante: NO llamar stop() aquí; hacerlo cortaba la frase en curso y
 * eliminaba cues intermedios cuando las traducciones llegaban más rápido
 * que la voz.
 */
export function speakTranslation(text: string, langCode: string): void {
  const cleaned = text.trim()
  if (!cleaned || !chrome.tts?.speak) return
  try {
    chrome.tts.speak(cleaned, {
      lang: ttsLocaleForLang(langCode),
      rate: 1.05,
      enqueue: true,
    })
  } catch (error) {
    console.warn("[subvid:tts] speak failed", error)
  }
}

export function stopSpeaking(): void {
  try {
    chrome.tts?.stop?.()
  } catch {
    /* ignore */
  }
}
