/**
 * Cliente HTTP de Hy-MT2 contra llama-server (API OpenAI compatible).
 * No descarga el GGUF. Si el servidor no responde, lanza un error controlado.
 */

import { normalizeHyMt2Settings } from "../shared/hymt2Config.ts"
import type { HyMt2Settings } from "../shared/types.ts"
import { buildHyMt2UserPrompt, HYMT2_SAMPLING } from "./hymt2Prompt.ts"
import type {
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from "./translationContract.ts"

export type HyMt2ErrorKind =
  | "connection"
  | "timeout"
  | "http"
  | "invalid"
  | "empty"

export class HyMt2TranslationError extends Error {
  readonly provider = "hymt2"
  readonly kind: HyMt2ErrorKind

  constructor(message: string, kind: HyMt2ErrorKind) {
    super(message)
    this.name = "HyMt2TranslationError"
    this.kind = kind
  }
}

export type HyMt2Health = {
  available: boolean
  detail: string
}

function collectModelIds(entry: unknown): string[] {
  if (!entry || typeof entry !== "object") return []
  const record = entry as Record<string, unknown>
  const ids: string[] = []
  for (const key of ["id", "name", "model"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      ids.push(record[key].trim())
    }
  }
  if (Array.isArray(record.aliases)) {
    for (const alias of record.aliases) {
      if (typeof alias === "string" && alias.trim()) ids.push(alias.trim())
    }
  }
  return ids
}

/** Acepta el nombre de archivo o una ruta que termine en ese archivo. */
function modelNameMatches(configured: string, listed: string): boolean {
  const wanted = configured.trim().toLowerCase().replace(/\\/g, "/")
  const value = listed.trim().toLowerCase().replace(/\\/g, "/")
  if (!wanted || !value) return false
  if (value === wanted) return true
  const wantedBase = wanted.split("/").pop() || wanted
  const listedBase = value.split("/").pop() || value
  return listedBase === wantedBase
}

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const NOTICE_INTERVAL_MS = 8_000
let lastUnavailableNoticeAt = 0

export function resetHyMt2NoticeState() {
  lastUnavailableNoticeAt = 0
}

function unavailableMessage(baseUrl: string) {
  return `Hy-MT2 unavailable at ${baseUrl}`
}

function logTranslationMetric(entry: {
  sourceLanguage: string
  targetLanguage: string
  inputLength: number
  outputLength: number
  latencyMs: number
  error?: HyMt2ErrorKind
}) {
  console.info("[subvid:hymt2]", {
    provider: "hymt2",
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    inputLength: entry.inputLength,
    outputLength: entry.outputLength,
    latencyMs: Math.round(entry.latencyMs),
    ...(entry.error ? { error: entry.error } : {}),
  })
}

function warnUnavailable(baseUrl: string, kind: HyMt2ErrorKind) {
  const now = Date.now()
  if (now - lastUnavailableNoticeAt < NOTICE_INTERVAL_MS) return
  lastUnavailableNoticeAt = now
  const message =
    kind === "timeout"
      ? `${unavailableMessage(baseUrl)} (timeout)`
      : kind === "http"
        ? `${unavailableMessage(baseUrl)} (HTTP error)`
        : kind === "invalid"
          ? `${unavailableMessage(baseUrl)} (invalid response)`
          : kind === "empty"
            ? `${unavailableMessage(baseUrl)} (empty translation)`
            : unavailableMessage(baseUrl)
  console.warn(`[subvid:hymt2] ${message}`)
}

export function extractChatCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new HyMt2TranslationError(
      "Hy-MT2 invalid response",
      "invalid",
    )
  }
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new HyMt2TranslationError(
      "Hy-MT2 invalid response",
      "invalid",
    )
  }
  const message = (choices[0] as { message?: { content?: unknown } })?.message
  let content = message?.content
  if (Array.isArray(content)) {
    content = content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text || "")
        }
        return ""
      })
      .join("")
  }
  if (typeof content !== "string") {
    throw new HyMt2TranslationError(
      "Hy-MT2 invalid response",
      "invalid",
    )
  }
  const text = content.trim()
  if (!text) {
    throw new HyMt2TranslationError("Hy-MT2 empty translation", "empty")
  }
  return text
}

function combineSignals(
  timeoutMs: number,
  external?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!external) return timeoutSignal
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([external, timeoutSignal])
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (external.aborted || timeoutSignal.aborted) {
    controller.abort()
    return controller.signal
  }
  external.addEventListener("abort", abort, { once: true })
  timeoutSignal.addEventListener("abort", abort, { once: true })
  return controller.signal
}

function classifyFetchError(
  error: unknown,
  baseUrl: string,
  timeoutMs: number,
): HyMt2TranslationError {
  if (error instanceof HyMt2TranslationError) return error
  const name = error instanceof Error ? error.name : ""
  const message = error instanceof Error ? error.message : String(error)
  if (name === "TimeoutError" || name === "AbortError") {
    return new HyMt2TranslationError(
      `${unavailableMessage(baseUrl)} (timeout ${timeoutMs}ms)`,
      "timeout",
    )
  }
  if (
    error instanceof TypeError ||
    /failed|refused|network|fetch/i.test(message)
  ) {
    return new HyMt2TranslationError(unavailableMessage(baseUrl), "connection")
  }
  return new HyMt2TranslationError(unavailableMessage(baseUrl), "connection")
}

export class HyMt2TranslationProvider implements TranslationProvider {
  readonly id = "hymt2"
  private settings: HyMt2Settings
  private fetchImpl: FetchLike

  constructor(
    settings?: Partial<HyMt2Settings>,
    fetchImpl?: FetchLike,
  ) {
    this.settings = normalizeHyMt2Settings({
      ...settings,
    })
    this.fetchImpl = fetchImpl || ((input, init) => fetch(input, init))
  }

  getSettings() {
    return this.settings
  }

  async checkHealth(signal?: AbortSignal): Promise<HyMt2Health> {
    const url = `${this.settings.baseUrl}/v1/models`
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: signal || AbortSignal.timeout(Math.min(this.settings.timeoutMs, 4_000)),
      })
      if (!response.ok) {
        return {
          available: false,
          detail: `${unavailableMessage(this.settings.baseUrl)} (HTTP ${response.status})`,
        }
      }
      const payload = (await response.json()) as { data?: unknown }
      const data = payload?.data
      if (!Array.isArray(data) || data.length === 0) {
        return {
          available: false,
          detail: `${unavailableMessage(this.settings.baseUrl)} (invalid response)`,
        }
      }
      const ids = data.flatMap((entry) => collectModelIds(entry))
      if (
        ids.length > 0 &&
        !ids.some((id) => modelNameMatches(this.settings.model, id))
      ) {
        return {
          available: false,
          detail: `${unavailableMessage(this.settings.baseUrl)} (model ${this.settings.model} not listed)`,
        }
      }
      return { available: true, detail: "Hy-MT2 available" }
    } catch (error) {
      const classified = classifyFetchError(
        error,
        this.settings.baseUrl,
        this.settings.timeoutMs,
      )
      return { available: false, detail: classified.message }
    }
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const text = request.text.trim()
    const started = performance.now()
    const inputLength = text.length
    if (!text) {
      return {
        translatedText: "",
        provider: "hymt2",
        latencyMs: 0,
        metadata: {
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          inputLength: 0,
          outputLength: 0,
        },
      }
    }

    const prompt = buildHyMt2UserPrompt(request)
    const url = `${this.settings.baseUrl}/v1/chat/completions`
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.settings.model,
          messages: [{ role: "user", content: prompt }],
          temperature: HYMT2_SAMPLING.temperature,
          top_p: HYMT2_SAMPLING.top_p,
          top_k: HYMT2_SAMPLING.top_k,
          repeat_penalty: HYMT2_SAMPLING.repeat_penalty,
          max_tokens: HYMT2_SAMPLING.max_tokens,
        }),
        signal: combineSignals(this.settings.timeoutMs, request.signal),
      })
      if (!response.ok) {
        throw new HyMt2TranslationError(
          `${unavailableMessage(this.settings.baseUrl)} (HTTP ${response.status})`,
          "http",
        )
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new HyMt2TranslationError(
          `${unavailableMessage(this.settings.baseUrl)} (invalid response)`,
          "invalid",
        )
      }
      const translatedText = extractChatCompletionText(payload)
      const latencyMs = performance.now() - started
      logTranslationMetric({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        inputLength,
        outputLength: translatedText.length,
        latencyMs,
      })
      return {
        translatedText,
        provider: "hymt2",
        latencyMs,
        metadata: {
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
          inputLength,
          outputLength: translatedText.length,
          latencyMs: Math.round(latencyMs),
        },
      }
    } catch (error) {
      if (request.signal?.aborted) throw error
      const classified = classifyFetchError(
        error,
        this.settings.baseUrl,
        this.settings.timeoutMs,
      )
      const latencyMs = performance.now() - started
      logTranslationMetric({
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        inputLength,
        outputLength: 0,
        latencyMs,
        error: classified.kind,
      })
      warnUnavailable(this.settings.baseUrl, classified.kind)
      throw classified
    }
  }
}
