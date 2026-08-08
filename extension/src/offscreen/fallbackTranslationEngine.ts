/**
 * Motor legacy: envuelve TranslationProvider (Chrome → Marian → NLLB).
 */

import { translationBackendInfo } from "../shared/languages.ts"
import type { TranslationBackendInfo } from "../shared/types.ts"
import {
  emptyLoadMetrics,
  type TranslateEngineInput,
  type TranslateEngineResult,
  type TranslationEngine,
  type TranslationEngineLoadMetrics,
  type TranslationEngineState,
} from "./translationEngine.ts"
import {
  TranslationProvider,
  type LegacyForceBackend,
  type WorkerClient,
} from "./translationProvider.ts"

type ProgressFn = (key: string, payload: any) => void
type StatusFn = (phase: string, detail?: string, progress?: number) => void

export class FallbackTranslationEngine implements TranslationEngine {
  readonly id = "legacy-cascade" as const
  private provider: TranslationProvider
  private state: TranslationEngineState = "idle"
  private metrics = emptyLoadMetrics()
  private lastError: string | null = null

  constructor(opts: {
    createWorkerClient: (
      worker: Worker,
      onProgress: ProgressFn,
    ) => WorkerClient
    onProgress: ProgressFn
    postStatus: StatusFn
    onBackendChange: (backend: TranslationBackendInfo | null) => void
    forceBackend?: LegacyForceBackend | null
  }) {
    this.provider = new TranslationProvider({
      createWorkerClient: opts.createWorkerClient,
      onProgress: opts.onProgress,
      postStatus: opts.postStatus,
      onBackendChange: (backend) => {
        if (backend) this.state = "ready"
        opts.onBackendChange(backend)
      },
      forceBackend: opts.forceBackend,
    })
  }

  getState() {
    return this.state
  }

  getBackend() {
    return this.provider.getBackend()
  }

  getLoadMetrics() {
    return { ...this.metrics }
  }

  getLastError() {
    return this.lastError
  }

  /** Acceso al provider subyacente (warmup / ensure). */
  getProvider() {
    return this.provider
  }

  async warmUp(sourceLang: string, targetLang: string) {
    this.state = "loading"
    this.metrics.modelLoadStart = Date.now()
    try {
      await this.provider.ensure(sourceLang, targetLang)
      this.metrics.modelLoadEnd = Date.now()
      this.metrics.modelLoadDuration =
        this.metrics.modelLoadEnd - this.metrics.modelLoadStart
      this.state = this.provider.getBackend() ? "ready" : "idle"
    } catch (error) {
      this.lastError = String((error as Error)?.message || error)
      this.state = "error"
      this.metrics.modelLoadEnd = Date.now()
      this.metrics.modelLoadDuration =
        this.metrics.modelLoadEnd - (this.metrics.modelLoadStart || Date.now())
      throw error
    }
  }

  async translate(input: TranslateEngineInput): Promise<TranslateEngineResult> {
    this.metrics.translationStart = Date.now()
    try {
      const text = await this.provider.translate(input)
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration =
        this.metrics.translationEnd - this.metrics.translationStart
      const backend = this.provider.getBackend()
      if (backend) this.state = "ready"
      return {
        text,
        backend,
        translationDurationMs: this.metrics.translationDuration,
        modelLoadDurationMs: this.metrics.modelLoadDuration,
      }
    } catch (error) {
      this.lastError = String((error as Error)?.message || error)
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration =
        this.metrics.translationEnd - this.metrics.translationStart
      throw error
    }
  }

  dispose() {
    this.provider.dispose()
    this.state = "idle"
  }
}

/** Info de backend cuando el cascade activo es el legacy. */
export function legacyBackendLabel(
  backend: TranslationBackendInfo | null,
): TranslationBackendInfo | null {
  if (!backend) return null
  if (backend.id === "chrome-translator") {
    return translationBackendInfo("chrome-translator")
  }
  if (backend.id === "marian") {
    return translationBackendInfo("marian", backend.model)
  }
  return translationBackendInfo("nllb")
}
