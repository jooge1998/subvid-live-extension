/**
 * Router de motores según Settings.translationEngine.
 * - auto: TranslateGemma → legacy cascade
 * - translategemma: solo Gemma (sin ocultar errores en translate; fallback solo si falla carga)
 * - chrome/marian/nllb: fuerza ese backend
 */

import type {
  TranslationBackendInfo,
  TranslationEngineChoice,
} from "../shared/types.ts"
import { FallbackTranslationEngine } from "./fallbackTranslationEngine.ts"
import { pipelineMetrics } from "./pipelineMetrics.ts"
import {
  type TranslateEngineInput,
  type TranslateEngineResult,
  type TranslationEngine,
  type TranslationEngineState,
} from "./translationEngine.ts"
import {
  TranslateGemmaEngine,
  type TranslationModelSize,
} from "./translateGemmaEngine.ts"
import type {
  LegacyForceBackend,
  WorkerClient,
} from "./translationProvider.ts"

type ProgressFn = (key: string, payload: any) => void
type StatusFn = (phase: string, detail?: string, progress?: number) => void

export type CascadingTranslationEngineOptions = {
  createWorkerClient: (
    worker: Worker,
    onProgress: ProgressFn,
  ) => WorkerClient
  onProgress: ProgressFn
  postStatus: StatusFn
  onBackendChange: (backend: TranslationBackendInfo | null) => void
  translationEngine?: TranslationEngineChoice
  /** @deprecated */
  preferTranslateGemma?: boolean
  translationModelSize?: TranslationModelSize
}

function softStatus(postStatus: StatusFn, detail: string, progress?: number) {
  // No usar phase "loading/downloading" tras listening: oculta UI (historial).
  // El content muestra el detail; phase "listening" mantiene controles.
  postStatus("listening", detail, progress)
}

export class CascadingTranslationEngine implements TranslationEngine {
  readonly id = "legacy-cascade" as const
  private gemma: TranslateGemmaEngine | null = null
  private fallback: FallbackTranslationEngine
  private active: TranslationEngine
  private choice: TranslationEngineChoice
  private allowGemmaFallback: boolean
  private onBackendChange: (backend: TranslationBackendInfo | null) => void
  private postStatus: StatusFn
  private warmupStarted = false

  constructor(opts: CascadingTranslationEngineOptions) {
    this.choice = opts.translationEngine || "auto"
    this.allowGemmaFallback = this.choice === "auto"
    this.onBackendChange = opts.onBackendChange
    this.postStatus = opts.postStatus

    const forceLegacy: LegacyForceBackend | null =
      this.choice === "chrome-translator" ||
      this.choice === "marian" ||
      this.choice === "nllb"
        ? this.choice
        : null

    this.fallback = new FallbackTranslationEngine({
      createWorkerClient: opts.createWorkerClient,
      onProgress: opts.onProgress,
      postStatus: (phase, detail, progress) => {
        if (phase === "downloading" || phase === "loading") {
          softStatus(opts.postStatus, detail || "Cargando traductor…", progress)
        } else {
          opts.postStatus(phase, detail, progress)
        }
      },
      onBackendChange: (backend) => {
        if (this.active === this.fallback) {
          this.onBackendChange(backend)
          pipelineMetrics.translationEngine = backend?.id || "legacy-cascade"
        }
      },
      forceBackend: forceLegacy,
    })

    const wantGemma =
      this.choice === "auto" || this.choice === "translategemma"

    if (wantGemma) {
      this.gemma = new TranslateGemmaEngine({
        createWorkerClient: opts.createWorkerClient,
        onProgress: opts.onProgress,
        postStatus: (phase, detail, progress) => {
          if (phase === "downloading" || phase === "loading") {
            softStatus(
              opts.postStatus,
              detail || "Cargando TranslateGemma…",
              progress,
            )
          } else {
            opts.postStatus(phase, detail, progress)
          }
        },
        onBackendChange: (backend) => {
          if (this.active === this.gemma) {
            this.onBackendChange(backend)
            pipelineMetrics.translationEngine = backend?.id || "translategemma"
          }
        },
        modelSize: "4b",
        allowCpuFallback: false,
      })
      this.active = this.choice === "translategemma" ? this.gemma : this.fallback
    } else {
      this.active = this.fallback
      pipelineMetrics.translationEngine = forceLegacy || "legacy-cascade"
    }
  }

  getState(): TranslationEngineState {
    return this.active.getState()
  }

  getBackend() {
    return this.active.getBackend() || this.fallback.getBackend()
  }

  getLoadMetrics() {
    return this.active.getLoadMetrics()
  }

  getFallback() {
    return this.fallback
  }

  getGemma() {
    return this.gemma
  }

  async warmUp(sourceLang: string, targetLang: string) {
    this.warmupStarted = true

    if (this.choice === "translategemma" && this.gemma) {
      await this.gemma.warmUp(sourceLang, targetLang)
      this.active = this.gemma
      this.onBackendChange(this.gemma.getBackend())
      pipelineMetrics.translationEngine = "translategemma"
      softStatus(this.postStatus, "TranslateGemma listo")
      return
    }

    if (
      this.choice === "chrome-translator" ||
      this.choice === "marian" ||
      this.choice === "nllb"
    ) {
      await this.fallback.warmUp(sourceLang, targetLang)
      this.active = this.fallback
      this.onBackendChange(this.fallback.getBackend())
      return
    }

    // auto
    try {
      await this.fallback.warmUp(sourceLang, targetLang)
      this.active = this.fallback
      this.onBackendChange(this.fallback.getBackend())
      pipelineMetrics.translationEngine =
        this.fallback.getBackend()?.id || "legacy-cascade"
    } catch (error) {
      console.warn("[subvid:engine] fallback warmup failed", error)
    }

    if (this.gemma) {
      void this.gemma
        .warmUp(sourceLang, targetLang)
        .then(() => {
          if (this.gemma?.getState() === "ready") {
            this.active = this.gemma
            this.onBackendChange(this.gemma.getBackend())
            pipelineMetrics.translationEngine = "translategemma"
            softStatus(this.postStatus, "TranslateGemma listo (en memoria)")
            console.info("[subvid:engine] TranslateGemma ready")
          }
        })
        .catch((error) => {
          console.warn(
            "[subvid:engine] TranslateGemma unavailable, using fallback",
            error,
          )
          this.active = this.fallback
          this.onBackendChange(this.fallback.getBackend())
        })
    }
  }

  async translate(input: TranslateEngineInput): Promise<TranslateEngineResult> {
    const queueWaitStart = Date.now()
    if (
      this.gemma &&
      this.active === this.gemma &&
      this.gemma.getState() !== "ready"
    ) {
      if (this.allowGemmaFallback) this.active = this.fallback
    }

    const tryEngine = async (engine: TranslationEngine) => {
      const t0 = Date.now()
      pipelineMetrics.translationQueueWait = t0 - queueWaitStart
      const result = await engine.translate(input)
      pipelineMetrics.translationDuration =
        result.translationDurationMs ?? Date.now() - t0
      if (result.modelLoadDurationMs != null) {
        pipelineMetrics.modelLoadDuration = result.modelLoadDurationMs
      }
      pipelineMetrics.translationEngine = result.backend?.id || engine.id
      this.onBackendChange(result.backend)
      return result
    }

    try {
      return await tryEngine(this.active)
    } catch (error) {
      if (this.active === this.gemma && this.allowGemmaFallback) {
        console.warn(
          "[subvid:engine] TranslateGemma translate failed → fallback",
          error,
        )
        this.active = this.fallback
        return await tryEngine(this.fallback)
      }
      throw error
    }
  }

  dispose() {
    this.gemma?.dispose()
    this.fallback.dispose()
    this.gemma = null
    this.active = this.fallback
  }

  get warmupWasStarted() {
    return this.warmupStarted
  }
}
