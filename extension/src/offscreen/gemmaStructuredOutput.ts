/**
 * Salida estructurada de TranslateGemma: traducción + completitud lingüística.
 * Una sola inferencia; sin llamada extra isComplete().
 */

export type GemmaCompletionReason =
  | "complete_sentence"
  | "complete_short_utterance"
  | "grammatical_fragment"
  | "continuation_expected"
  | "ambiguous"
  | "unknown"

export type GemmaStructuredTranslation = {
  translation: string
  /** null = el modelo no devolvió señal usable (fallback a heurísticas). */
  complete: boolean | null
  confidence: number
  reason: GemmaCompletionReason
}

const REASONS = new Set<string>([
  "complete_sentence",
  "complete_short_utterance",
  "grammatical_fragment",
  "continuation_expected",
  "ambiguous",
  "unknown",
])

function normalizeReason(raw: unknown): GemmaCompletionReason {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
  return (REASONS.has(s) ? s : "unknown") as GemmaCompletionReason
}

function clampConfidence(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  if (v > 1 && v <= 100) return Math.min(1, v / 100)
  return Math.max(0, Math.min(1, v))
}

/** Extrae el primer objeto JSON del texto (tolera fences ```json). */
export function extractJsonObject(raw: string): unknown | null {
  const text = String(raw || "").trim()
  if (!text) return null
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  try {
    return JSON.parse(unfenced)
  } catch {
    /* buscar primer { … } balanceado */
  }
  const start = unfenced.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(unfenced.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Parsea la salida del modelo. Si no hay JSON válido, trata el texto como
 * traducción plana y complete=null (no inventar completitud).
 */
export function parseGemmaStructuredOutput(
  raw: string,
  _sourceText?: string,
): GemmaStructuredTranslation {
  const parsed = extractJsonObject(raw)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const translation = String(
      obj.translation ?? obj.text ?? obj.translated ?? "",
    ).trim()
    const hasComplete = typeof obj.complete === "boolean"
    const completeFlag = hasComplete ? (obj.complete as boolean) : null
    return {
      translation,
      complete: completeFlag,
      confidence: hasComplete ? clampConfidence(obj.confidence ?? 0.75) : 0,
      reason: normalizeReason(obj.reason),
    }
  }

  return {
    translation: String(raw || "").trim(),
    complete: null,
    confidence: 0,
    reason: "unknown",
  }
}

/** Prompt de usuario para una sola inferencia: traducir + complete. */
export function buildGemmaStructuredUserPrompt(opts: {
  text: string
  sourceLang: string
  targetLang: string
  previousContext?: string[]
}): string {
  const ctx = (opts.previousContext || [])
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(-2)
  const ctxBlock = ctx.length ? ctx.join(" | ") : "(none)"

  return [
    `Task: Translate from ${opts.sourceLang} to ${opts.targetLang} and judge if SOURCE is a complete linguistic unit by itself.`,
    ``,
    `Return ONLY one JSON object. No markdown. No text outside JSON.`,
    `Schema:`,
    `{"translation":"...","complete":true,"confidence":0.0,"reason":"complete_sentence"}`,
    ``,
    `reason must be one of:`,
    `complete_sentence, complete_short_utterance, grammatical_fragment, continuation_expected, ambiguous, unknown`,
    ``,
    `Rules:`,
    `- translation = translation of SOURCE only. Do NOT invent, complete, or continue the source.`,
    `- complete=true only if SOURCE is a finished utterance on its own.`,
    `- If SOURCE normally requires continuation (e.g. "I think", "Because", "And then"), complete=false.`,
    `- Short finished utterances ("Yes.", "Exactly.", "Thank you.") → complete=true, reason=complete_short_utterance.`,
    `- CONTEXT is only for translation disambiguation. Do NOT use CONTEXT to invent missing words or to force complete=true.`,
    ``,
    `Examples:`,
    `SOURCE: I think → complete=false`,
    `SOURCE: I think we should → complete=false`,
    `SOURCE: I think we should do this. → complete=true`,
    `SOURCE: Because → complete=false`,
    `SOURCE: Because we need more time. → complete=true`,
    `SOURCE: Yes. → complete=true`,
    `SOURCE: Exactly. → complete=true`,
    `SOURCE: Thank you. → complete=true`,
    `SOURCE: And then → complete=false`,
    `SOURCE: And then we left. → complete=true`,
    ``,
    `SOURCE:`,
    opts.text.trim(),
    ``,
    `CONTEXT (optional, do not translate):`,
    ctxBlock,
  ].join("\n")
}
