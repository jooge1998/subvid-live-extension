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
 * Habla texto con chrome.tts (interrupción del utterance anterior).
 * No-op si el permiso/API no está disponible.
 */
export function speakTranslation(text: string, langCode: string): void {
  const cleaned = text.trim()
  if (!cleaned || !chrome.tts?.speak) return
  try {
    chrome.tts.stop()
    chrome.tts.speak(cleaned, {
      lang: ttsLocaleForLang(langCode),
      rate: 1.05,
      enqueue: false,
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
