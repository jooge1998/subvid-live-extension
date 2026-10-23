import type { HyMt2Settings } from "./types.ts"

/** Valores por defecto. El usuario puede cambiarlos en el popup. */
export const DEFAULT_HYMT2_SETTINGS: HyMt2Settings = {
  baseUrl: "http://127.0.0.1:8080",
  model: "Hy-MT2-1.8B-Q4_K_M.gguf",
  timeoutMs: 10_000,
}

const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000

export function normalizeHyMt2Settings(value: unknown): HyMt2Settings {
  const raw =
    value && typeof value === "object"
      ? (value as Partial<HyMt2Settings>)
      : {}

  let baseUrl =
    typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : ""
  baseUrl = baseUrl.replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(baseUrl)) {
    baseUrl = DEFAULT_HYMT2_SETTINGS.baseUrl
  }

  const model =
    typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim()
      : DEFAULT_HYMT2_SETTINGS.model

  const parsed = Number(raw.timeoutMs)
  const timeoutMs = Number.isFinite(parsed)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)))
    : DEFAULT_HYMT2_SETTINGS.timeoutMs

  return { baseUrl, model, timeoutMs }
}
