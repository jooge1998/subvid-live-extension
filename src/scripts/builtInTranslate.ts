// Chrome Prompt API (Gemini Nano) for subtitle translation between en, es, and ja.
// Other common pairs can use MarianMT; everything else falls back to NLLB.

import { MARIAN_TRANSLATION_MODELS } from "@/scripts/languages.ts"

type BuiltInBackend = "prompt"
type TranslationBackend = BuiltInBackend | "marian" | "nllb"
type SubtitleCue = { text: string; start?: number; end?: number }
type TranslateOptions = {
  onProgress?: (ratio: number) => void
  onReady?: () => void
  onBatch?: (current: number, total: number) => void
  sourceLabel?: string
  targetLabel?: string
}

// The subset of Chrome's Prompt API (not yet in the DOM typings) used here.
type PromptSession = {
  prompt(
    input: string,
    options: { responseConstraint: object; signal: AbortSignal },
  ): Promise<string>
}
type LanguageModelOptions = {
  expectedInputs: { type: "text"; languages: string[] }[]
  expectedOutputs: { type: "text"; languages: string[] }[]
}
type LanguageModelApi = {
  availability(options: LanguageModelOptions): Promise<string>
  create(
    options: LanguageModelOptions & {
      initialPrompts: { role: "system"; content: string }[]
      signal: AbortSignal
      monitor(monitor: EventTarget): void
    },
  ): Promise<PromptSession>
}

const languageModel = () =>
  (globalThis as { LanguageModel?: LanguageModelApi }).LanguageModel

/** Languages Gemini Nano can read and write in Chrome today. */
const NANO_LANGS = new Set(["en", "es", "ja"])
const TRANSLATION_DEBUG = import.meta.env.DEV

const promptSessionByPair = new Map<string, PromptSession>()
const backendByPair = new Map<string, TranslationBackend>()

function pairKey(source: string, target: string) {
  return `${source}:${target}`
}

function toBcp47(code: string) {
  return code === "zh" ? "zh" : code
}

function formatCueTime(seconds?: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return ""
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`
    : `${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`
}

function onDownloadProgress(
  callback: TranslateOptions["onProgress"],
  e: Event & { loaded?: number },
) {
  if (typeof callback !== "function") return
  const loaded = e?.loaded
  if (typeof loaded === "number") callback(Math.min(1, loaded))
}

function timeoutError(label: string, ms: number) {
  return new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(label, ms)
      controller.abort(error)
      reject(error)
    }, ms)
  })

  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function logTranslate(event: string, details: Record<string, unknown> = {}) {
  if (!TRANSLATION_DEBUG) return
  console.info(`[translate] ${event}`, details)
}

function logPromptBatch({
  source,
  target,
  batchNumber,
  totalBatches,
  prompt,
  input,
  raw,
  output,
}: {
  source: string
  target: string
  batchNumber: number
  totalBatches: number
  prompt: string
  input: SubtitleCue[]
  raw: string
  output: unknown[]
}) {
  if (!TRANSLATION_DEBUG) return

  console.groupCollapsed(
    `[translate:prompt] ${source} -> ${target} batch ${batchNumber}/${totalBatches}`,
  )
  console.debug("prompt", prompt)
  console.table(
    input.map((cue, index) => ({
      index,
      input: cue.text,
      raw: Array.isArray(output) ? output[index] : "",
      output: Array.isArray(output) ? output[index] : "",
    })),
  )
  console.debug("raw result", raw)
  console.groupEnd()
}

function subtitleSystemPrompt(sourceLabel: string, targetLabel: string) {
  return (
    `You translate video subtitles from ${sourceLabel} to ${targetLabel}.\n\n` +
    "Context: these are timed on-screen captions from a video, not prose or chat.\n\n" +
    "Rules:\n" +
    "- Output exactly one translated string per input cue, in the same order\n" +
    "- Keep each line concise and readable on screen; match the source tone and register\n" +
    "- Preserve names, brands, and technical terms when appropriate\n" +
    "- Translate non-speech descriptions inside square brackets while preserving the brackets, e.g. [APPLAUSE] becomes [APLAUSOS] in Spanish\n" +
    "- Do not merge, split, or reorder cues\n" +
    "- Whitespace-only cues must stay empty\n" +
    "- No speaker labels, quotes, numbering, stage directions, or explanations\n" +
    "- Return only the JSON array requested by the user"
  )
}

function formatCueBlock(cues: SubtitleCue[], offset: number) {
  return cues
    .map((cue, j) => {
      const idx = offset + j + 1
      const range =
        typeof cue.start === "number" && typeof cue.end === "number"
          ? ` (${formatCueTime(cue.start)} → ${formatCueTime(cue.end)})`
          : ""
      return `${idx}.${range} ${cue.text}`
    })
    .join("\n")
}

export function isNanoLanguagePair(source: string, target: string) {
  return (
    source !== target &&
    NANO_LANGS.has(source) &&
    NANO_LANGS.has(target)
  )
}

export async function probeBuiltInTranslation(
  source: string,
  target: string,
): Promise<BuiltInBackend | null> {
  if (!isNanoLanguagePair(source, target)) return null
  const api = languageModel()
  if (!api) return null

  const src = toBcp47(source)
  const tgt = toBcp47(target)

  const inputLangs = [...new Set(["en", src, tgt])]
  try {
    const availability = await api.availability({
      expectedInputs: [{ type: "text", languages: inputLangs }],
      expectedOutputs: [{ type: "text", languages: [tgt] }],
    })
    if (availability !== "unavailable") return "prompt"
  } catch {
    /* NLLB fallback */
  }
  return null
}

export { hasBuiltInTranslationSupport } from "@/scripts/builtInSupport.ts"

export async function resolveTranslationBackend(
  source: string,
  target: string,
): Promise<TranslationBackend> {
  const key = pairKey(source, target)
  const known = backendByPair.get(key)
  if (known) return known
  const builtIn = await probeBuiltInTranslation(source, target)
  const backend: TranslationBackend =
    builtIn || (MARIAN_TRANSLATION_MODELS[key] ? "marian" : "nllb")
  backendByPair.set(key, backend)
  return backend
}

async function getPromptSession(
  source: string,
  target: string,
  sourceLabel: string,
  targetLabel: string,
  opts: TranslateOptions,
) {
  const src = toBcp47(source)
  const tgt = toBcp47(target)
  const key = pairKey(src, tgt)
  const existing = promptSessionByPair.get(key)
  if (existing) {
    opts.onReady?.()
    return existing
  }
  const api = languageModel()
  if (!api) throw new Error("Prompt API unavailable")

  const inputLangs = [...new Set(["en", src, tgt])]
  const startedAt = performance.now()
  logTranslate("chrome-session:start", { source, target })
  const session = await withTimeout(
    (signal) =>
      api.create({
        expectedInputs: [{ type: "text", languages: inputLangs }],
        expectedOutputs: [{ type: "text", languages: [tgt] }],
        initialPrompts: [
          {
            role: "system",
            content: subtitleSystemPrompt(sourceLabel, targetLabel),
          },
        ],
        signal,
        monitor(m) {
          m.addEventListener("downloadprogress", (e) =>
            onDownloadProgress(
              opts.onProgress,
              e as Event & { loaded?: number },
            ),
          )
        },
      }),
    180_000,
    "Chrome translation session",
  )
  logTranslate("chrome-session:ready", {
    source,
    target,
    elapsedMs: Math.round(performance.now() - startedAt),
  })
  promptSessionByPair.set(key, session)
  opts.onReady?.()
  return session
}

const PROMPT_BATCH = 20

/** `source` and `target` are the app's BCP 47-ish language codes. */
export async function translateCuesBuiltIn(
  cues: SubtitleCue[],
  source: string,
  target: string,
  opts: TranslateOptions = {},
) {
  const backend = await resolveTranslationBackend(source, target)
  if (backend !== "prompt") {
    throw new Error("Prompt API unavailable for this language pair")
  }

  const sourceLabel = opts.sourceLabel || source
  const targetLabel = opts.targetLabel || target
  const onProgress = opts.onProgress
  const session = await getPromptSession(
    source,
    target,
    sourceLabel,
    targetLabel,
    opts,
  )

  const out: string[] = []
  const totalBatches = Math.max(1, Math.ceil(cues.length / PROMPT_BATCH))
  logTranslate("chrome-translation:start", {
    source,
    target,
    cues: cues.length,
    batches: totalBatches,
  })
  for (let i = 0; i < cues.length; i += PROMPT_BATCH) {
    const batch = cues.slice(i, i + PROMPT_BATCH)
    const batchNumber = Math.floor(i / PROMPT_BATCH) + 1
    const schema = {
      type: "array",
      items: { type: "string" },
      minItems: batch.length,
      maxItems: batch.length,
    }
    const prompt =
      `Translate exactly ${batch.length} subtitle cues from ${sourceLabel} to ${targetLabel}.\n` +
      `Return a JSON array of ${batch.length} strings in the same order.\n\n` +
      formatCueBlock(batch, i)

    opts.onBatch?.(batchNumber, totalBatches)
    const batchStartedAt = performance.now()
    logTranslate("chrome-batch:start", {
      source,
      target,
      batch: batchNumber,
      batches: totalBatches,
      cues: batch.length,
    })
    let raw: string
    try {
      raw = await withTimeout(
        (signal) => session.prompt(prompt, { responseConstraint: schema, signal }),
        60_000,
        "Chrome subtitle translation",
      )
    } catch (error) {
      console.warn("[translate] chrome-batch:failed", {
        source,
        target,
        batch: batchNumber,
        batches: totalBatches,
        elapsedMs: Math.round(performance.now() - batchStartedAt),
        error,
      })
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Prompt API returned invalid JSON")
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error("Prompt API returned unexpected shape")
    }
    logPromptBatch({
      source,
      target,
      batchNumber,
      totalBatches,
      prompt,
      input: batch,
      raw,
      output: parsed,
    })
    out.push(...parsed.map((s) => String(s ?? "").trim()))
    logTranslate("chrome-batch:done", {
      source,
      target,
      batch: batchNumber,
      batches: totalBatches,
      elapsedMs: Math.round(performance.now() - batchStartedAt),
    })
    if (typeof onProgress === "function") {
      onProgress(Math.min(1, out.length / cues.length))
    }
    await new Promise((r) => setTimeout(r, 0))
  }
  return out
}

export function builtInBackendLabel() {
  return "Gemini Nano"
}
