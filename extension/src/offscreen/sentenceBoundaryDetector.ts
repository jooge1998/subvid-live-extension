/**
 * Detecta si un segmento ASR es probablemente una unidad lingüística completa.
 * NO usa el traductor: la segmentación pertenece al pipeline audio + ASR.
 */

export type BoundaryReason =
  | "terminal_punctuation"
  | "long_silence"
  | "short_complete_utterance"
  | "continuation_word"
  | "grammatical_fragment"
  | "whisper_unstable"
  | "max_segment_duration"
  | "max_fragment_length"

export type BoundaryInput = {
  text: string
  previousText?: string
  /** Silencio al cerrar el chunk (segundos). */
  silenceDuration: number
  /** Duración del audio del cue/fragmento (segundos). */
  audioDuration: number
  /** 0..1 si Whisper/estabilidad lo aportan. */
  asrConfidence?: number
  isWhisperStable?: boolean
  /** Forzar cierre por límites de fragmento pendiente. */
  forceComplete?: boolean
  forceReason?: BoundaryReason
  /** Umbral de silencio “claro” (perfil Live ~0.6–0.75). */
  silenceClearSeconds?: number
  maxSegmentSeconds?: number
  debug?: boolean
}

export type BoundaryResult = {
  isLikelyComplete: boolean
  confidence: number
  reason: BoundaryReason
}

/** Frases cortas que suelen ser enunciados completos. */
const SHORT_COMPLETE = new Set(
  [
    "yes",
    "no",
    "yeah",
    "yep",
    "yup",
    "ok",
    "okay",
    "exactly",
    "right",
    "sure",
    "thanks",
    "thank you",
    "please",
    "wait",
    "hello",
    "hi",
    "bye",
    "goodbye",
    "come on",
    "let's go",
    "lets go",
    "i don't know",
    "i dont know",
    "sí",
    "si",
    "no",
    "vale",
    "claro",
    "exacto",
    "gracias",
  ].map((s) => s.toLowerCase()),
)

/** Palabras finales que suelen indicar continuación. */
const CONTINUATION_ENDINGS = new Set(
  [
    "and",
    "or",
    "but",
    "because",
    "that",
    "if",
    "when",
    "while",
    "although",
    "though",
    "to",
    "of",
    "for",
    "with",
    "a",
    "an",
    "the",
    "my",
    "your",
    "our",
    "their",
    "his",
    "her",
    "its",
    "we",
    "they",
    "i",
    "you",
    "he",
    "she",
    "it",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "can",
    "may",
    "might",
    "must",
    "need",
    "needs",
    "want",
    "wants",
    "think",
    "this",
    "these",
    "those",
    "there",
    "here",
    "so",
    "as",
    "at",
    "in",
    "on",
    "by",
    "from",
    "into",
    "about",
    "y",
    "o",
    "pero",
    "porque",
    "que",
    "si",
    "cuando",
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "un",
    "una",
    "al",
  ].map((s) => s.toLowerCase()),
)

/** Inicios típicos de fragmento gramatical incompleto. */
const FRAGMENT_PREFIXES = [
  /^i think$/i,
  /^i think we$/i,
  /^we need to$/i,
  /^they were$/i,
  /^this is$/i,
  /^this is exactly$/i,
  /^this is exactly what$/i,
  /^and then$/i,
  /^because$/i,
  /^because we$/i,
  /^because we need$/i,
]

function stripOuterPunctuation(text: string) {
  return text
    .trim()
    .replace(/^[\s"'«»]+|[\s"'«»]+$/g, "")
    .replace(/\s+/g, " ")
}

function lastWord(text: string): string {
  const words = stripOuterPunctuation(text)
    .replace(/[.!?…,;:]+$/u, "")
    .trim()
    .split(/\s+/)
  return (words[words.length - 1] || "").toLowerCase()
}

function hasTerminalPunctuation(text: string): boolean {
  return /[.!?…]["'»)]*\s*$/u.test(text.trim())
}

function wordCount(text: string): number {
  const t = stripOuterPunctuation(text)
  if (!t) return 0
  return t.split(/\s+/).length
}

function isShortCompleteUtterance(text: string): boolean {
  const core = stripOuterPunctuation(text)
    .replace(/[.!?…]+$/u, "")
    .trim()
    .toLowerCase()
  if (!core) return false
  if (SHORT_COMPLETE.has(core)) return true
  // Una sola palabra afirmativa/corta con puntuación terminal.
  if (wordCount(core) <= 2 && hasTerminalPunctuation(text)) {
    return SHORT_COMPLETE.has(core) || /^[\p{L}'’-]{1,12}$/u.test(core)
  }
  return false
}

function looksLikeGrammaticalFragment(text: string): boolean {
  const trimmed = stripOuterPunctuation(text)
  if (!trimmed) return false
  if (FRAGMENT_PREFIXES.some((re) => re.test(trimmed))) return true
  const last = lastWord(trimmed)
  if (CONTINUATION_ENDINGS.has(last) && !hasTerminalPunctuation(trimmed)) {
    return true
  }
  // Muy corto sin puntuación y sin ser enunciado completo conocido.
  if (
    wordCount(trimmed) <= 3 &&
    !hasTerminalPunctuation(trimmed) &&
    !isShortCompleteUtterance(trimmed)
  ) {
    return true
  }
  return false
}

/**
 * Analiza si el texto ASR es probablemente FINAL o todavía provisional.
 */
export function analyzeBoundary(input: BoundaryInput): BoundaryResult {
  const text = (input.text || "").trim()
  const silenceClear = input.silenceClearSeconds ?? 0.6
  const maxSeg = input.maxSegmentSeconds ?? 8

  if (input.forceComplete) {
    const result: BoundaryResult = {
      isLikelyComplete: true,
      confidence: 0.95,
      reason: input.forceReason || "max_fragment_length",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (!text) {
    const result: BoundaryResult = {
      isLikelyComplete: false,
      confidence: 0.9,
      reason: "grammatical_fragment",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (input.isWhisperStable === false || (input.asrConfidence ?? 1) < 0.45) {
    const result: BoundaryResult = {
      isLikelyComplete: false,
      confidence: 0.75,
      reason: "whisper_unstable",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (input.audioDuration >= maxSeg) {
    const result: BoundaryResult = {
      isLikelyComplete: true,
      confidence: 0.7,
      reason: "max_segment_duration",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (isShortCompleteUtterance(text)) {
    // Frases tipo "Yes." / "Exactly." — final tras pausa breve razonable.
    const enoughSilence = input.silenceDuration >= Math.min(0.35, silenceClear)
    const result: BoundaryResult = {
      isLikelyComplete: enoughSilence || hasTerminalPunctuation(text),
      confidence: enoughSilence ? 0.92 : 0.7,
      reason: "short_complete_utterance",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (looksLikeGrammaticalFragment(text)) {
    const last = lastWord(text)
    const reason: BoundaryReason = CONTINUATION_ENDINGS.has(last)
      ? "continuation_word"
      : "grammatical_fragment"
    const result: BoundaryResult = {
      isLikelyComplete: false,
      confidence: 0.82,
      reason,
    }
    logBoundary(input.debug, result)
    return result
  }

  const punct = hasTerminalPunctuation(text)
  const longSilence = input.silenceDuration >= silenceClear

  if (punct && longSilence) {
    const result: BoundaryResult = {
      isLikelyComplete: true,
      confidence: 0.9,
      reason: "terminal_punctuation",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (longSilence && (input.isWhisperStable || (input.asrConfidence ?? 0) >= 0.7)) {
    const result: BoundaryResult = {
      isLikelyComplete: true,
      confidence: 0.8,
      reason: "long_silence",
    }
    logBoundary(input.debug, result)
    return result
  }

  if (punct && !longSilence) {
    // Whisper a veces puntúa antes de que el audio termine.
    const result: BoundaryResult = {
      isLikelyComplete: false,
      confidence: 0.55,
      reason: "whisper_unstable",
    }
    logBoundary(input.debug, result)
    return result
  }

  const result: BoundaryResult = {
    isLikelyComplete: false,
    confidence: 0.6,
    reason: "grammatical_fragment",
  }
  logBoundary(input.debug, result)
  return result
}

function logBoundary(debug: boolean | undefined, result: BoundaryResult) {
  if (!debug) return
  console.debug(
    `[subvid:boundary] isLikelyComplete=${result.isLikelyComplete} confidence=${result.confidence} reason=${result.reason}`,
  )
}
