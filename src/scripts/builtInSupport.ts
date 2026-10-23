// Kept apart from builtInTranslate.ts so the initial bundle can check for
// Chrome's built-in AI without loading the translation code.
export function hasBuiltInTranslationSupport() {
  return "LanguageModel" in globalThis
}
