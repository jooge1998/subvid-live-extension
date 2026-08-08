/**
 * Adaptador TranslateGemma 4B (ONNX / WebGPU) vía worker dedicado.
 *
 * Usa `@huggingface/transformers-v4` (alias npm de 4.2.0) SOLO en el worker,
 * sin tocar el pin 3.8.1 de Marian/NLLB/Whisper.
 *
 * Si WebGPU falta, la carga falla o el runtime no soporta Gemma3:
 * el CascadingTranslationEngine cae al fallback legacy.
 */

import type { TranslationBackendInfo } from "../shared/types.ts"
import {
  emptyLoadMetrics,
  type TranslateEngineInput,
  type TranslateEngineResult,
  type TranslationEngine,
  type TranslationEngineLoadMetrics,
  type TranslationEngineState,
} from "./translationEngine.ts"
import type { WorkerClient } from "./translationProvider.ts"

/** Modelo ONNX oficial de la comunidad (Gemma3ForCausalLM). ~2.9 GB q4. */
export const TRANSLATEGEMMA_MODEL_4B =
  "onnx-community/translategemma-text-4b-it-ONNX"

export type TranslationModelSize = "4b" | "fallback"

/** Timeout producción (cascade). El diagnóstico usa uno más largo. */
export const TRANSLATEGEMMA_LOAD_TIMEOUT_MS = 300_000
/** Primera descarga ~2.9 GB + compile WebGPU puede superar 5–15 min. */
export const TRANSLATEGEMMA_DIAGNOSTIC_LOAD_TIMEOUT_MS = 1_200_000

const MODEL_LOAD_TIMEOUT_MS = TRANSLATEGEMMA_LOAD_TIMEOUT_MS

export type TranslateGemmaOptions = {
  createWorkerClient: (
    worker: Worker,
    onProgress: (key: string, payload: any) => void,
  ) => WorkerClient
  onProgress: (key: string, payload: any) => void
  postStatus: (phase: string, detail?: string, progress?: number) => void
  onBackendChange: (backend: TranslationBackendInfo | null) => void
  /** No cargar 4B en CPU automáticamente. */
  allowCpuFallback?: boolean
  modelSize?: TranslationModelSize
  modelId?: string
  /** Override timeout ensure (ms). */
  loadTimeoutMs?: number
}

async function hasUsableWebGPU(): Promise<boolean> {
  const nav = globalThis.navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown> }
  }
  if (!nav?.gpu) return false
  try {
    const adapter = await nav.gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

/**
 * Limpia salida del modelo: quita prefacios tipo "Translation:" sin
 * truncar traducciones gramaticalmente distintas del input.
 */
export function cleanGemmaTranslation(raw: string, sourceText: string): string {
  let text = String(raw || "").trim()
  if (!text) return ""

  // Quitar fences / roles residuales.
  text = text
    .replace(/^```[\s\S]*?```$/g, "")
    .replace(/^(assistant|model)\s*[:：]\s*/i, "")
    .replace(/^(translation|traducci[oó]n)\s*[:：]\s*/i, "")
    .trim()

  // Si el modelo devolvió el prompt entero, intentar última línea útil.
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length > 1) {
    const withoutMeta = lines.filter(
      (l) =>
        !/^(source|target|context|previous|note|note:)/i.test(l) &&
        l !== sourceText.trim(),
    )
    if (withoutMeta.length) text = withoutMeta[withoutMeta.length - 1]
  }

  // Evitar eco del source en el mismo idioma cuando es idéntico y corto.
  if (
    text.toLowerCase() === sourceText.trim().toLowerCase() &&
    sourceText.trim().split(/\s+/).length <= 2
  ) {
    return text
  }

  return text.trim()
}

export class TranslateGemmaEngine implements TranslationEngine {
  readonly id = "translategemma" as const
  private client: WorkerClient | null = null
  private state: TranslationEngineState = "idle"
  private metrics = emptyLoadMetrics()
  private backend: TranslationBackendInfo | null = null
  private lastError: string | null = null
  private lastStructuredError: ReturnType<
    typeof import("./gemmaErrorClassify.ts").classifyGemmaError
  > | null = null
  private loadPromise: Promise<void> | null = null
  private opts: TranslateGemmaOptions
  private modelSize: TranslationModelSize
  private modelId: string
  private loadTimeoutMs: number
  private workerCreatedOnce = false
  private lastEnsureResult: {
    reused: boolean
    loadCount?: number
    transformersJsVersion?: string
    device?: string
  } | null = null

  constructor(opts: TranslateGemmaOptions) {
    this.opts = opts
    this.modelSize = opts.modelSize || "4b"
    this.modelId = opts.modelId || TRANSLATEGEMMA_MODEL_4B
    this.loadTimeoutMs = opts.loadTimeoutMs ?? MODEL_LOAD_TIMEOUT_MS
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

  getLastError() {
    return this.lastError
  }

  getLastStructuredError() {
    return this.lastStructuredError
  }

  getLastEnsureResult() {
    return this.lastEnsureResult
  }

  didCreateWorker() {
    return this.workerCreatedOnce
  }

  /** Re-envía ensure al worker (para verificar reutilización). */
  async ensureAgain(): Promise<{
    reused: boolean
    loadCount?: number
    transformersJsVersion?: string
  }> {
    await this.ensureLoaded()
    if (!this.client) throw new Error("worker no disponible")
    const result = await this.client.call(
      "ensure-translategemma",
      {
        model: this.modelId,
        device: "webgpu",
        dtype: "q4",
      },
      [],
      this.loadTimeoutMs,
    )
    this.lastEnsureResult = {
      reused: !!result?.reused,
      loadCount: result?.loadCount,
      transformersJsVersion: result?.transformersJsVersion,
      device: result?.device,
    }
    return this.lastEnsureResult
  }

  async warmUp(_sourceLang: string, _targetLang: string) {
    if (this.modelSize === "fallback") {
      this.state = "error"
      this.lastError = "TRANSLATION_MODEL_SIZE=fallback (TranslateGemma desactivado)"
      return
    }
    await this.ensureLoaded()
  }

  private async ensureLoaded() {
    if (this.state === "ready" && this.client) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      this.state = "loading"
      this.metrics.modelLoadStart = Date.now()
      this.opts.postStatus("loading", "Comprobando WebGPU para TranslateGemma…")

      const webgpu = await hasUsableWebGPU()
      if (!webgpu && !this.opts.allowCpuFallback) {
        this.state = "error"
        this.lastError =
          "WebGPU no disponible: no se carga TranslateGemma 4B en CPU"
        this.lastStructuredError = {
          code: "WEBGPU_UNAVAILABLE",
          message: this.lastError,
          fullError: this.lastError,
          backend: "webgpu",
        }
        this.metrics.modelLoadEnd = Date.now()
        this.metrics.modelLoadDuration =
          this.metrics.modelLoadEnd - this.metrics.modelLoadStart
        this.opts.onBackendChange(null)
        throw Object.assign(new Error(this.lastError), {
          structured: this.lastStructuredError,
        })
      }

      if (!this.client) {
        console.info("[TranslateGemma] worker created")
        this.workerCreatedOnce = true
        this.client = this.opts.createWorkerClient(
          new Worker(new URL("./translategemma.worker.ts", import.meta.url), {
            type: "module",
          }),
          this.opts.onProgress,
        )
      }

      this.opts.postStatus(
        "downloading",
        "Descargando TranslateGemma 4B (solo una vez)…",
        0,
      )
      console.info("[TranslateGemma] model loading")

      try {
        const result = await this.client.call(
          "ensure-translategemma",
          {
            model: this.modelId,
            device: webgpu ? "webgpu" : "wasm",
            dtype: "q4",
          },
          [],
          this.loadTimeoutMs,
        )
        this.lastEnsureResult = {
          reused: !!result?.reused,
          loadCount: result?.loadCount,
          transformersJsVersion: result?.transformersJsVersion,
          device: result?.device,
        }
      } catch (error) {
        const { classifyGemmaError } = await import("./gemmaErrorClassify.ts")
        const structured =
          (error as any)?.structured ||
          classifyGemmaError(error, webgpu ? "webgpu" : "wasm")
        this.state = "error"
        this.lastStructuredError = structured
        this.lastError = structured.fullError
        this.metrics.modelLoadEnd = Date.now()
        this.metrics.modelLoadDuration =
          this.metrics.modelLoadEnd - this.metrics.modelLoadStart
        this.opts.onBackendChange(null)
        console.error("[TranslateGemma] worker error", this.lastError)
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { structured },
        )
      }

      this.metrics.modelLoadEnd = Date.now()
      this.metrics.modelLoadDuration =
        this.metrics.modelLoadEnd - this.metrics.modelLoadStart
      this.state = "ready"
      this.backend = {
        id: "translategemma",
        label: "TranslateGemma 4B",
        model: "4b-it-onnx-q4",
      }
      this.opts.onBackendChange(this.backend)
      this.opts.postStatus("loading", "TranslateGemma listo")
      console.info("[TranslateGemma] model ready")
    })()

    try {
      await this.loadPromise
    } finally {
      if (this.state === "error") this.loadPromise = null
    }
  }

  async translate(input: TranslateEngineInput): Promise<TranslateEngineResult> {
    await this.ensureLoaded()
    if (!this.client || this.state !== "ready") {
      throw Object.assign(
        new Error(this.lastError || "TranslateGemma no está listo"),
        { structured: this.lastStructuredError },
      )
    }

    this.metrics.translationStart = Date.now()
    console.info("[TranslateGemma] translate start")
    try {
      const result = await this.client.call("translate", {
        text: input.text,
        previousContext: input.previousContext.slice(-2),
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
      })
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration =
        this.metrics.translationEnd - this.metrics.translationStart
      console.info(
        "[TranslateGemma] translate end",
        this.metrics.translationDuration,
      )

      const raw = String(result?.text ?? "")
      const cleaned = cleanGemmaTranslation(raw, input.text)
      return {
        text: cleaned || null,
        backend: this.backend,
        translationDurationMs: this.metrics.translationDuration,
        modelLoadDurationMs: this.metrics.modelLoadDuration,
      }
    } catch (error) {
      const { classifyGemmaError } = await import("./gemmaErrorClassify.ts")
      this.metrics.translationEnd = Date.now()
      this.metrics.translationDuration =
        this.metrics.translationEnd - this.metrics.translationStart
      const structured =
        (error as any)?.structured || classifyGemmaError(error, "webgpu")
      this.lastStructuredError = structured
      this.lastError = structured.fullError
      console.error("[TranslateGemma] worker error", this.lastError)
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { structured },
      )
    }
  }

  dispose() {
    if (this.client) {
      this.client.terminate()
      this.client = null
    }
    this.state = "idle"
    this.backend = null
    this.loadPromise = null
    this.workerCreatedOnce = false
  }
}
