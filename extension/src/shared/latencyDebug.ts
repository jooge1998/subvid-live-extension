/**
 * Instrumentación de latencia (solo medición / formato debug).
 * No altera el pipeline: calcula deltas a partir de timestamps.
 */

import type { CueLatencyMetrics } from "../shared/types.ts"

function ms(a?: number, b?: number): number | undefined {
  if (a == null || b == null) return undefined
  return Math.max(0, Math.round(b - a))
}

/** Rellena deltas derivados a partir de timestamps absolutos. */
export function enrichLatencyMetrics(
  m: CueLatencyMetrics,
): CueLatencyMetrics {
  const firstRenderedAt = m.firstRenderedAt ?? m.firstTextRenderedAt
  const finalCueAt = m.finalCueAt ?? m.finalAt

  const audioToChunkMs = ms(m.audioCapturedAt, m.chunkCreatedAt)
  const queueWaitMs = ms(m.chunkCreatedAt, m.asrStartedAt)
  const asrLatencyMs = ms(m.asrStartedAt, m.asrFinishedAt)
  const translationLatencyMs = ms(
    m.translationStartedAt,
    m.translationFinishedAt,
  )
  const firstTextLatencyMs =
    ms(m.audioCapturedAt, firstRenderedAt) ??
    ms(m.audioCapturedAt, m.asrFinishedAt)
  const totalLatencyMs =
    ms(m.audioCapturedAt, finalCueAt) ??
    ms(m.audioCapturedAt, m.translationFinishedAt) ??
    firstTextLatencyMs

  return {
    ...m,
    firstRenderedAt,
    finalCueAt,
    audioToChunkMs,
    queueWaitMs,
    asrLatencyMs,
    translationLatencyMs,
    firstTextLatencyMs,
    timeToFirstText: firstTextLatencyMs,
    timeToTranslation:
      m.timeToTranslation ??
      ms(m.audioCapturedAt, m.translationRenderedAt) ??
      ms(m.audioCapturedAt, m.translationFinishedAt),
    timeToFinalCue: m.timeToFinalCue ?? totalLatencyMs,
    totalLatencyMs,
  }
}

/** Panel de debug: identifica chunking / cola / Whisper / traducción. */
export function formatLatencyDebugPanel(m?: CueLatencyMetrics | null): string {
  if (!m) return ""
  const e = enrichLatencyMetrics(m)
  const line = (label: string, value?: number) =>
    value == null ? null : `${label}: ${value} ms`

  return [
    line("Audio → Chunk", e.audioToChunkMs),
    line("Queue wait", e.queueWaitMs),
    line("ASR", e.asrLatencyMs),
    line("Translation", e.translationLatencyMs),
    line("First text", e.firstTextLatencyMs),
    line("Final", e.totalLatencyMs),
  ]
    .filter(Boolean)
    .join("\n")
}

/** Una línea compacta para el popup. */
export function formatLatencyDebugInline(m?: CueLatencyMetrics | null): string {
  return formatLatencyDebugPanel(m).replace(/\n/g, " · ")
}
