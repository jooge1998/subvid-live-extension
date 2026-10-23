/**
 * Adaptador de Hy-MT2 al motor que ya usa el pipeline.
 * Un fallo de llama-server deja el texto traducido en null y no relanza.
 */

import { translationBackendInfo } from "../shared/languages.ts"
import type { HyMt2Settings, TranslationBackendInfo } from "../shared/types.ts"
import { HyMt2TranslationProvider } from "./hyMt2TranslationProvider.ts"
import {
  emptyLoadMetrics,
  type TranslateEngineInput,
  type TranslateEngineResult,
  type TranslationEngine,
  type TranslationEngineLoadMetrics,
  type TranslationEngineState,
} from "./translationEngine.ts"

type StatusFn = (phase: string, detail?: string, progress?: number) => void

export type HyMt2EngineOptions = {
  settings: HyMt2Settings
  postStatus: StatusFn
  onBackendChange: (backend: TranslationBackendInfo | null) => void
  fetchImpl?: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>
}

export class HyMt2TranslationEngine implements TranslationEngine {
  readonly id = "hymt2" as const
  private provider: HyMt2TranslationProvider
  private state: TranslationEngineState = "idle"
  private metrics = emptyLoadMetrics()
  private backend: TranslationBackendInfo | null = null
  private opts: HyMt2EngineOptions
  private lastNotice = ""

  constructor(opts: HyMt2EngineOptions) {
    this.opts = opts
    this.provider = new HyMt2TranslationProvider(opts.settings, opts.fetchImpl)
    this.backend = translationBackendInfo("hymt2", opts.settings.model)
  }

  getState() {
    return this.state
  }

  getBackend() {
    return this.backend
  }

  getLoadMetrics(): TranslationEngineLoadMetrics {
    return { ...this.metrics }
  }

  getProvider() {
    return this.provider
  }

  async warmUp(_sourceLang: string, _targetLang: string) {
    this.state = "loading"
    const health = await this.provider.checkHealth()
    if (health.available) {
      this.state = "ready"
      this.opts.onBackendChange(this.backend)
      this.opts.postStatus("listening", "Hy-MT2 available")
      return
    }
    this.state = "error"
    this.noteUnavailable(health.detail)
  }

  async translate(input: TranslateEngineInput): Promise<TranslateEngineResult> {
    const started = Date.now()
    this.metrics.translationStart = started
    try {
      const result = await this.provider.translate({
        text: input.text,
        sourceLanguage: input.sourceLang,
        targetLanguage: input.targetLang,
        context: input.previousContext,
      })
      const latency = result.latencyMs ?? Date.now() - started
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration = latency
      if (result.translatedText.trim()) this.state = "ready"
      return {
        text: result.translatedText.trim() || null,
        backend: this.backend,
        translationDurationMs: latency,
        inputLength: input.text.length,
        outputLength: result.translatedText.trim().length,
      }
    } catch (error) {
      const latency = Date.now() - started
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration = latency
      this.state = "error"
      const message =
        error instanceof Error
          ? error.message
          : "Hy-MT2 unavailable"
      this.noteUnavailable(message)
      return {
        text: null,
        backend: this.backend,
        translationDurationMs: latency,
        inputLength: input.text.length,
        outputLength: 0,
      }
    }
  }

  dispose() {
    this.state = "idle"
  }

  private noteUnavailable(detail: string) {
    if (detail === this.lastNotice) return
    this.lastNotice = detail
    this.opts.postStatus("listening", detail)
  }
}
