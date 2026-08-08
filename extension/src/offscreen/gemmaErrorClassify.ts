/**
 * Clasificación de errores TranslateGemma para diagnóstico (sin ocultar).
 */

export type GemmaErrorCode =
  | "MODEL_MEMORY_ERROR"
  | "MODEL_LOAD_TIMEOUT"
  | "WEBGPU_UNAVAILABLE"
  | "WEBGPU_ADAPTER_ERROR"
  | "WEBGPU_DEVICE_ERROR"
  | "ONNX_OPERATOR_ERROR"
  | "ONNX_RUNTIME_ERROR"
  | "MODEL_LOAD_ERROR"
  | "INFERENCE_ERROR"
  | "WORKER_ERROR"
  | "UNKNOWN_ERROR"

export type StructuredGemmaError = {
  code: GemmaErrorCode
  message: string
  fullError: string
  operator?: string
  node?: string
  backend?: string
}

export function classifyGemmaError(
  error: unknown,
  backend?: string,
): StructuredGemmaError {
  const fullError = String((error as Error)?.stack || (error as Error)?.message || error)
  const message = String((error as Error)?.message || error)

  if (
    /out of memory|oom|failed to allocate|enomem|insufficient memory|memory limit|could not allocate|gpu.*memory|vram/i.test(
      fullError,
    )
  ) {
    return {
      code: "MODEL_MEMORY_ERROR",
      message: "Fallo de memoria al cargar o ejecutar el modelo",
      fullError,
      backend,
    }
  }

  if (/\btimeout\b/i.test(message)) {
    return {
      code: "MODEL_LOAD_TIMEOUT",
      message:
        "Timeout cargando TranslateGemma (descarga o inicialización WebGPU aún en curso)",
      fullError,
      backend,
    }
  }

  if (/conversations must start with a user prompt/i.test(message)) {
    return {
      code: "WORKER_ERROR",
      message:
        "Chat template: la conversación debe empezar con role=user (sin system). Usar formato TranslateGemma source/target_lang_code.",
      fullError,
      backend,
    }
  }

  const opMatch = fullError.match(
    /(?:Unsupported|unsupported|Unknown|unknown)\s+(?:operator|op(?:erator)?(?:\s+type)?)\s*[:\s]+['"]?([A-Za-z0-9_]+)/i,
  )
  const nodeMatch = fullError.match(
    /(?:node|Node)\s*[:\s]+['"]?([A-Za-z0-9_./-]+)/,
  )
  if (
    opMatch ||
    /MatMulNBits|TransposeDQWeights|Missing required scale|not supported.*op/i.test(
      fullError,
    )
  ) {
    return {
      code: "ONNX_OPERATOR_ERROR",
      message: "Operador ONNX / WebGPU no soportado",
      fullError,
      operator: opMatch?.[1],
      node: nodeMatch?.[1],
      backend,
    }
  }

  if (/webgpu|gpu adapter|requestDevice|requestAdapter/i.test(fullError)) {
    return {
      code: "WEBGPU_DEVICE_ERROR",
      message: "Error de WebGPU",
      fullError,
      backend: backend || "webgpu",
    }
  }

  if (/onnx|ort\.|onnxruntime/i.test(fullError)) {
    return {
      code: "ONNX_RUNTIME_ERROR",
      message: "Error de ONNX Runtime",
      fullError,
      backend,
    }
  }

  if (/load|download|fetch|ensure-translategemma|pipeline/i.test(fullError)) {
    return {
      code: "MODEL_LOAD_ERROR",
      message,
      fullError,
      backend,
    }
  }

  return {
    code: "UNKNOWN_ERROR",
    message,
    fullError,
    backend,
  }
}

export function percentile(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  )
  return sortedAsc[idx]
}

export function formatDiagnosticReportText(report: {
  conclusion: string
  verdict: Record<string, string>
  performance: Record<string, unknown>
  memory: Record<string, unknown>
  compatibility: Record<string, unknown>
  samples?: Array<{ input: string; output: string | null; ms: number; ok: boolean }>
  errors: StructuredGemmaError[]
  browser?: string
  model?: string
  transformersJsVersion?: string
}): string {
  const lines: string[] = []
  lines.push("=== TranslateGemma 4B DIAGNOSTIC ===")
  lines.push(`Conclusion: ${report.conclusion}`)
  lines.push("")
  lines.push("--- Verdict ---")
  for (const [k, v] of Object.entries(report.verdict)) {
    lines.push(`${k}: ${v}`)
  }
  lines.push("")
  lines.push("--- Performance ---")
  for (const [k, v] of Object.entries(report.performance)) {
    lines.push(`${k}: ${v}`)
  }
  lines.push("")
  lines.push("--- Memory ---")
  for (const [k, v] of Object.entries(report.memory)) {
    lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
  }
  lines.push("")
  lines.push("--- Compatibility ---")
  for (const [k, v] of Object.entries(report.compatibility)) {
    lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
  }
  if (report.samples?.length) {
    lines.push("")
    lines.push("--- Samples ---")
    for (const s of report.samples) {
      lines.push(
        `[${s.ok ? "OK" : "FAIL"}] ${s.ms}ms | "${s.input}" → "${s.output ?? ""}"`,
      )
    }
  }
  if (report.errors.length) {
    lines.push("")
    lines.push("--- Errors ---")
    for (const e of report.errors) {
      lines.push(`[${e.code}] ${e.message}`)
      if (e.operator) lines.push(`  operator: ${e.operator}`)
      if (e.node) lines.push(`  node: ${e.node}`)
      if (e.backend) lines.push(`  backend: ${e.backend}`)
      lines.push(`  full: ${e.fullError}`)
    }
  }
  if (report.browser) lines.push(`\nbrowser: ${report.browser}`)
  if (report.model) lines.push(`model: ${report.model}`)
  if (report.transformersJsVersion) {
    lines.push(`transformers.js: ${report.transformersJsVersion}`)
  }
  return lines.join("\n")
}
