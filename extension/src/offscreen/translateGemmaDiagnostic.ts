/**
 * Suite de validación REAL de TranslateGemma 4B.
 * Sin Whisper / VAD / TTS / overlay / cascade fallback.
 *
 * Popup → background → offscreen → este módulo → TranslateGemmaEngine → worker
 */

import {
  classifyGemmaError,
  formatDiagnosticReportText,
  percentile,
  type StructuredGemmaError,
} from "./gemmaErrorClassify.ts"
import {
  TRANSLATEGEMMA_DIAGNOSTIC_LOAD_TIMEOUT_MS,
  TRANSLATEGEMMA_MODEL_4B,
  TranslateGemmaEngine,
} from "./translateGemmaEngine.ts"
import type { WorkerClient } from "./translationProvider.ts"
import { probeWebGpu, type WebGpuProbeResult } from "./webgpuProbe.ts"

export type PassFail = "PASS" | "FAIL" | "SKIP"

export type DiagnosticProgress = {
  phase: string
  detail?: string
  progress?: number
}

export type InferenceSample = {
  input: string
  output: string | null
  rawOutput: string | null
  ms: number
  ok: boolean
  note?: string
}

export type TranslateGemmaDiagnosticReport = {
  browser: string
  webgpu: WebGpuProbeResult
  backendUsed: string | null
  transformersJsVersion: string
  model: string
  estimatedSizeGb: number
  downloadStart: number | null
  downloadEnd: number | null
  downloadDurationMs: number | null
  loadStart: number | null
  loadEnd: number | null
  loadDurationMs: number | null
  workerCreated: boolean
  workerReusedForSecondEnsure: boolean | null
  requestIds: number[]
  samples: InferenceSample[]
  continuationChecks: InferenceSample[]
  repetitionChecks: InferenceSample[]
  modelLoadDuration: number | null
  firstInferenceDuration: number | null
  averageInferenceDuration: number | null
  p50: number | null
  p95: number | null
  errors: StructuredGemmaError[]
  verdict: {
    download: PassFail
    worker: PassFail
    webgpu: PassFail
    modelLoad: PassFail
    inference: PassFail
    warmInference: PassFail
  }
  performance: Record<string, string | number | null>
  memory: Record<string, unknown>
  compatibility: Record<string, unknown>
  conclusion: string
  textReport: string
  cascadeDisabled: true
}

const BENCHMARK_PHRASES = [
  "Hello, how are you?",
  "I think we should make some changes.",
  "Because",
  "Yes.",
  "We need to talk about this.",
]

const CONTINUATION_CASES = [
  {
    input: "I think",
    forbidden: [/we should/i, /deberíamos/i, /hacer/i],
  },
  {
    input: "Because",
    forbidden: [/we need/i, /necesitamos/i, /porque\s+\w{4,}/i],
  },
  {
    input: "Yes.",
    forbidden: [/porque/i, /creo/i, /\bi think\b/i],
  },
]

const REPETITION_SEQUENCE = [
  "I think",
  "I think",
  "I think we should",
  "I think we should make some changes.",
]

function browserLabel() {
  const ua = navigator.userAgent
  const chrome = ua.match(/Chrome\/([\d.]+)/)
  return chrome ? `Chrome ${chrome[1]}` : ua.slice(0, 80)
}

function looksLikeSpanish(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /[áéíóúñ¿¡]/.test(t) ||
    /\b(hola|cómo|como|estás|estas|creo|deberíamos|deberiamos|porque|sí|si|necesitamos|cambios|hablar)\b/.test(
      t,
    )
  )
}

function looksLikeContinuation(
  input: string,
  output: string,
  forbidden: RegExp[],
): boolean {
  const inWords = input.trim().split(/\s+/).length
  const outWords = output.trim().split(/\s+/).length
  // Traducción razonable no debería ser mucho más larga en palabras.
  if (outWords > inWords + 4) return true
  return forbidden.some((re) => re.test(output))
}

type ProgressFn = (p: DiagnosticProgress) => void

/**
 * Cliente worker con logs [TranslateGemma] y requestId visibles.
 */
function createDiagnosticWorkerClient(
  worker: Worker,
  onProgress: (key: string, payload: any) => void,
  track: { requestIds: number[]; logs: string[] },
): WorkerClient {
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: unknown) => void }
  >()
  let reqId = 0

  worker.onmessage = (event) => {
    const data = event.data || {}
    const { id, type } = data
    if (type === "progress") {
      onProgress(data.key, data.payload)
      return
    }
    if (type === "log") {
      track.logs.push(String(data.message || ""))
      console.info(String(data.message || ""))
      return
    }
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (type === "error") {
      const structured = data.structured as StructuredGemmaError | undefined
      const err = new Error(data.error || "worker error")
      ;(err as any).structured = structured
      console.error("[TranslateGemma] worker error", data.error, structured)
      request.reject(err)
    } else {
      request.resolve(data.result)
    }
  }

  worker.onerror = (event) => {
    const reason = event.error || new Error(event.message)
    console.error("[TranslateGemma] worker error", reason)
    for (const [id, request] of pending) {
      pending.delete(id)
      request.reject(reason)
    }
  }

  return {
    call(type, payload, transfer = [], timeoutMs = 0) {
      const id = ++reqId
      track.requestIds.push(id)
      console.info(
        `[TranslateGemma] request id=${id} type=${type}`,
      )
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (fn: (v: unknown) => void, value: unknown) => {
          if (timer) clearTimeout(timer)
          fn(value)
        }
        pending.set(id, {
          resolve: (v) => finish(resolve, v),
          reject: (e) => finish(reject, e),
        })
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`Timeout (${type}) id=${id}`))
          }, timeoutMs)
        }
        try {
          worker.postMessage({ id, type, payload }, transfer)
        } catch (error) {
          pending.delete(id)
          if (timer) clearTimeout(timer)
          reject(error)
        }
      })
    },
    terminate() {
      worker.terminate()
    },
  }
}

export async function runTranslateGemmaDiagnostic(
  onProgress: ProgressFn = () => undefined,
): Promise<TranslateGemmaDiagnosticReport> {
  const errors: StructuredGemmaError[] = []
  const track = { requestIds: [] as number[], logs: [] as string[] }
  let workerCreated = false
  let workerReusedForSecondEnsure: boolean | null = null
  let downloadStart: number | null = null
  let downloadEnd: number | null = null
  let loadStart: number | null = null
  let loadEnd: number | null = null
  let backendUsed: string | null = null
  let transformersJsVersion = "4.2.0 (alias @huggingface/transformers-v4)"
  let deviceBackend: string | null = null

  const memory: Record<string, unknown> = {
    jsHeapSizeLimit:
      (performance as any).memory?.jsHeapSizeLimit ?? "unavailable",
    totalJSHeapSize:
      (performance as any).memory?.totalJSHeapSize ?? "unavailable",
    usedJSHeapSize:
      (performance as any).memory?.usedJSHeapSize ?? "unavailable",
    note: "Chrome performance.memory es aproximado; VRAM GPU no siempre es visible",
  }

  onProgress({ phase: "webgpu", detail: "Sondeando WebGPU…" })
  const webgpu = await probeWebGpu()
  const webgpuPass: PassFail =
    webgpu.navigatorGpuDefined &&
    webgpu.adapterAvailable &&
    webgpu.deviceAvailable
      ? "PASS"
      : "FAIL"

  if (webgpu.error) {
    errors.push({
      code:
        webgpu.error.code === "WEBGPU_UNAVAILABLE"
          ? "WEBGPU_UNAVAILABLE"
          : webgpu.error.code === "WEBGPU_DEVICE_ERROR" ||
              webgpu.error.code === "WEBGPU_DEVICE_NULL"
            ? "WEBGPU_DEVICE_ERROR"
            : "WEBGPU_ADAPTER_ERROR",
      message: webgpu.error.message,
      fullError: webgpu.error.message,
      backend: "webgpu",
    })
  }

  const samples: InferenceSample[] = []
  const continuationChecks: InferenceSample[] = []
  const repetitionChecks: InferenceSample[] = []

  let downloadPass: PassFail = "FAIL"
  let workerPass: PassFail = "FAIL"
  let modelLoadPass: PassFail = "FAIL"
  let inferencePass: PassFail = "FAIL"
  let warmPass: PassFail = "FAIL"

  let engine: TranslateGemmaEngine | null = null

  const buildReport = (conclusion: string): TranslateGemmaDiagnosticReport => {
    const warmDurations = samples.map((s) => s.ms).filter((n) => n > 0)
    const sorted = [...warmDurations].sort((a, b) => a - b)
    const first = warmDurations[0] ?? null
    const avg = warmDurations.length
      ? Math.round(
          warmDurations.reduce((a, b) => a + b, 0) / warmDurations.length,
        )
      : null
    const p50 = percentile(sorted, 50)
    const p95 = percentile(sorted, 95)
    const loadDuration =
      loadStart != null && loadEnd != null ? loadEnd - loadStart : null
    const downloadDuration =
      downloadStart != null && downloadEnd != null
        ? downloadEnd - downloadStart
        : null

    const verdict = {
      download: downloadPass,
      worker: workerPass,
      webgpu: webgpuPass,
      modelLoad: modelLoadPass,
      inference: inferencePass,
      warmInference: warmPass,
    }

    const performance = {
      downloadMs: downloadDuration,
      loadMs: loadDuration,
      modelLoadDuration: loadDuration,
      firstInferenceDuration: first,
      averageInferenceDuration: avg,
      p50,
      p95,
      coldStartNote:
        "cold start = download+load; warm = inferencias tras model ready",
    }

    const operatorErrors = errors.filter((e) => e.code === "ONNX_OPERATOR_ERROR")
    const memoryErrors = errors.filter((e) => e.code === "MODEL_MEMORY_ERROR")

    const report: TranslateGemmaDiagnosticReport = {
      browser: browserLabel(),
      webgpu,
      backendUsed,
      transformersJsVersion,
      model: TRANSLATEGEMMA_MODEL_4B,
      estimatedSizeGb: 2.9,
      downloadStart,
      downloadEnd,
      downloadDurationMs: downloadDuration,
      loadStart,
      loadEnd,
      loadDurationMs: loadDuration,
      workerCreated,
      workerReusedForSecondEnsure,
      requestIds: [...track.requestIds],
      samples,
      continuationChecks,
      repetitionChecks,
      modelLoadDuration: loadDuration,
      firstInferenceDuration: first,
      averageInferenceDuration: avg,
      p50,
      p95,
      errors,
      verdict,
      performance,
      memory: {
        ...memory,
        memoryError: memoryErrors[0] || null,
        relevantGpuLimits: webgpu.limits,
      },
      compatibility: {
        problematicOperators: operatorErrors.map((e) => e.operator).filter(Boolean),
        onnxErrors: errors.filter((e) =>
          e.code.startsWith("ONNX"),
        ),
        webgpuErrors: errors.filter((e) => e.code.startsWith("WEBGPU")),
        adapterInfo: webgpu.adapterInfo,
        features: webgpu.features,
      },
      conclusion,
      textReport: "",
      cascadeDisabled: true,
    }
    report.textReport = formatDiagnosticReportText({
      conclusion,
      verdict,
      performance,
      memory: report.memory,
      compatibility: report.compatibility,
      samples: [
        ...samples,
        ...continuationChecks,
        ...repetitionChecks,
      ],
      errors,
      browser: report.browser,
      model: report.model,
      transformersJsVersion: report.transformersJsVersion,
    })
    return report
  }

  if (webgpuPass !== "PASS") {
    return buildReport(
      "TranslateGemma no es compatible con WebGPU/runtime actual (probe falló antes de cargar el modelo)",
    )
  }

  try {
    onProgress({ phase: "worker", detail: "Creando worker TranslateGemma…" })
    engine = new TranslateGemmaEngine({
      createWorkerClient: (worker, onProg) => {
        workerCreated = true
        console.info("[TranslateGemma] worker created")
        return createDiagnosticWorkerClient(worker, onProg, track)
      },
      onProgress: (key, payload) => {
        if (
          payload?.status === "progress" ||
          payload?.status === "download" ||
          payload?.status === "initiate"
        ) {
          if (downloadStart == null) downloadStart = Date.now()
          const pct =
            typeof payload.progress === "number"
              ? payload.progress > 1
                ? payload.progress / 100
                : payload.progress
              : undefined
          onProgress({
            phase: "download",
            detail: `Descargando ${payload.file || "pesos"}…`,
            progress: pct,
          })
        } else if (payload?.status === "heartbeat") {
          onProgress({
            phase: "load",
            detail: `Cargando… ${payload.elapsedSec ?? "?"}s (último progreso hace ${payload.sinceProgressSec ?? "?"}s)`,
          })
        } else if (payload?.status === "done") {
          if (downloadStart != null && downloadEnd == null) {
            downloadEnd = Date.now()
          }
        }
      },
      postStatus: (phase, detail, progress) => {
        onProgress({ phase, detail, progress })
      },
      onBackendChange: (backend) => {
        backendUsed = backend?.id || null
      },
      allowCpuFallback: false,
      modelSize: "4b",
      loadTimeoutMs: TRANSLATEGEMMA_DIAGNOSTIC_LOAD_TIMEOUT_MS,
    })

    loadStart = Date.now()
    console.info("[TranslateGemma] model loading")
    onProgress({
      phase: "load",
      detail:
        "Cargando modelo (timeout diagnóstico 20 min; 1ª vez puede descargar ~2.9 GB)…",
    })

    try {
      await engine.warmUp("en", "es")
      if (downloadStart != null && downloadEnd == null) downloadEnd = Date.now()
      loadEnd = Date.now()
      downloadPass = downloadStart != null ? "PASS" : "PASS" // cache hit OK
      modelLoadPass = engine.getState() === "ready" ? "PASS" : "FAIL"
      workerPass = workerCreated ? "PASS" : "FAIL"
      backendUsed = engine.getBackend()?.id || "translategemma"
      deviceBackend = "webgpu"
      console.info("[TranslateGemma] model ready")
      onProgress({ phase: "ready", detail: "Modelo listo" })
    } catch (error) {
      loadEnd = Date.now()
      if (downloadStart != null && downloadEnd == null) downloadEnd = Date.now()
      const structured =
        (error as any)?.structured ||
        classifyGemmaError(error, deviceBackend || "webgpu")
      errors.push(structured)
      downloadPass = downloadStart != null ? "PASS" : "FAIL"
      modelLoadPass = "FAIL"
      workerPass = workerCreated ? "PASS" : "FAIL"
      engine.dispose()
      engine = null

      if (structured.code === "MODEL_MEMORY_ERROR") {
        return buildReport("TranslateGemma no puede cargar por memoria")
      }
      if (structured.code === "MODEL_LOAD_TIMEOUT") {
        return buildReport(
          "TranslateGemma carga incompleta por timeout (descarga/init WebGPU > límite). No es evidencia de incompatibilidad de operadores; reintentar con caché caliente o más tiempo.",
        )
      }
      if (structured.code === "ONNX_OPERATOR_ERROR") {
        return buildReport(
          "TranslateGemma no es compatible con WebGPU/runtime actual",
        )
      }
      return buildReport(
        "El modelo funciona pero necesita ajustes de runtime/conversión",
      )
    }

    if (!engine) {
      return buildReport(
        "El modelo funciona pero necesita ajustes de runtime/conversión",
      )
    }

    // Verificar reutilización: segundo ensure no debe recrear pipeline.
    onProgress({ phase: "reuse", detail: "Comprobando reutilización del modelo…" })
    try {
      const reuse = await engine.ensureAgain()
      workerReusedForSecondEnsure = reuse.reused === true
      if (reuse.transformersJsVersion) {
        transformersJsVersion = reuse.transformersJsVersion
      }
      if (!reuse.reused) {
        errors.push({
          code: "WORKER_ERROR",
          message: "El segundo ensure no reutilizó la instancia del modelo",
          fullError: JSON.stringify(reuse),
          backend: "webgpu",
        })
      }
    } catch (error) {
      workerReusedForSecondEnsure = false
      errors.push(classifyGemmaError(error, "webgpu"))
    }

    workerPass =
      workerCreated && engine.didCreateWorker() ? "PASS" : "FAIL"
    // Inferencias warm (5 frases)
    onProgress({ phase: "inference", detail: "Inferencias warm (5 frases)…" })
    for (const phrase of BENCHMARK_PHRASES) {
      const t0 = Date.now()
      console.info("[TranslateGemma] translate start", phrase)
      try {
        const result = await engine.translate({
          text: phrase,
          previousContext: [],
          sourceLang: "en",
          targetLang: "es",
        })
        const ms = Date.now() - t0
        console.info("[TranslateGemma] translate end", ms, result.text)
        const output = result.text
        const ok = !!(output && output.trim() && looksLikeSpanish(output))
        samples.push({
          input: phrase,
          output,
          rawOutput: output,
          ms,
          ok,
          note: ok ? undefined : "salida vacía o no parece español",
        })
      } catch (error) {
        const ms = Date.now() - t0
        const structured =
          (error as any)?.structured ||
          classifyGemmaError(error, "webgpu")
        errors.push(structured)
        samples.push({
          input: phrase,
          output: null,
          rawOutput: null,
          ms,
          ok: false,
          note: structured.code,
        })
        if (structured.code === "MODEL_MEMORY_ERROR") {
          engine.dispose()
          return buildReport("TranslateGemma no puede cargar por memoria")
        }
      }
    }

    inferencePass = samples.some((s) => s.ok) ? "PASS" : "FAIL"
    const warmOk = samples.filter((s) => s.ok)
    warmPass =
      warmOk.length >= 3 &&
      (warmOk.reduce((a, s) => a + s.ms, 0) / warmOk.length < 30_000)
        ? "PASS"
        : warmOk.length >= 1
          ? "PASS"
          : "FAIL"

    // Continuación: el modelo NO debe inventar
    onProgress({ phase: "continuation", detail: "Pruebas anti-continuación…" })
    for (const c of CONTINUATION_CASES) {
      const t0 = Date.now()
      try {
        const result = await engine.translate({
          text: c.input,
          previousContext: [],
          sourceLang: "en",
          targetLang: "es",
        })
        const ms = Date.now() - t0
        const output = result.text || ""
        const continued = looksLikeContinuation(c.input, output, c.forbidden)
        continuationChecks.push({
          input: c.input,
          output,
          rawOutput: output,
          ms,
          ok: !continued && !!output.trim(),
          note: continued
            ? "POSIBLE CONTINUACIÓN / ALUCINACIÓN"
            : "sin continuación evidente",
        })
      } catch (error) {
        errors.push(classifyGemmaError(error, "webgpu"))
        continuationChecks.push({
          input: c.input,
          output: null,
          rawOutput: null,
          ms: Date.now() - t0,
          ok: false,
          note: "error",
        })
      }
    }

    // Repetición: no reutilizar generación anterior incorrectamente
    onProgress({ phase: "repetition", detail: "Pruebas de repetición…" })
    let prevOut: string | null = null
    for (const phrase of REPETITION_SEQUENCE) {
      const t0 = Date.now()
      try {
        const result = await engine.translate({
          text: phrase,
          previousContext: [],
          sourceLang: "en",
          targetLang: "es",
        })
        const ms = Date.now() - t0
        const output = result.text || ""
        // Si el input cambió sustancialmente, la salida no debería ser idéntica a la anterior corta.
        const wronglyReused =
          prevOut != null &&
          phrase.length > prevOut.length + 5 &&
          output.trim() === prevOut.trim()
        repetitionChecks.push({
          input: phrase,
          output,
          rawOutput: output,
          ms,
          ok: !wronglyReused && !!output.trim(),
          note: wronglyReused
            ? "posible reutilización incorrecta de generación previa"
            : undefined,
        })
        prevOut = output
      } catch (error) {
        errors.push(classifyGemmaError(error, "webgpu"))
        repetitionChecks.push({
          input: phrase,
          output: null,
          rawOutput: null,
          ms: Date.now() - t0,
          ok: false,
        })
      }
    }

    workerPass = workerCreated && track.requestIds.length >= 2 ? "PASS" : workerPass

    // Conclusión
    const avg =
      samples.length > 0
        ? samples.reduce((a, s) => a + s.ms, 0) / samples.length
        : null
    let conclusion: string
    if (modelLoadPass === "FAIL") {
      conclusion =
        "El modelo funciona pero necesita ajustes de runtime/conversión"
    } else if (inferencePass === "FAIL") {
      conclusion =
        "TranslateGemma carga pero la inferencia falló o no devolvió traducción usable"
    } else if (avg != null && avg > 8_000) {
      conclusion = "TranslateGemma carga pero es demasiado lento"
    } else if (
      continuationChecks.some((c) => !c.ok && c.note?.includes("CONTINUACIÓN"))
    ) {
      conclusion =
        "TranslateGemma 4B funciona correctamente (con advertencia: posible continuación de frase)"
    } else {
      conclusion = "TranslateGemma 4B funciona correctamente"
    }

    // Intentar leer versión del worker si está en logs
    const verLog = track.logs.find((l) => /transformers\.js=/i.test(l))
    if (verLog) {
      const m = verLog.match(/transformers\.js=([^\s]+)/)
      if (m) transformersJsVersion = m[1]
    }

    return buildReport(conclusion)
  } catch (error) {
    errors.push(classifyGemmaError(error, "webgpu"))
    return buildReport(
      "TranslateGemma no es compatible con WebGPU/runtime actual",
    )
  } finally {
    engine?.dispose()
  }
}
