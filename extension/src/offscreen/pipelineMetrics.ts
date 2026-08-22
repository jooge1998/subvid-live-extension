/**
 * Contadores de pipeline para depurar Whisper vs segmentación vs traducción vs TTS.
 */

export type PipelineMetricsSnapshot = {
  translationEngine: string
  modelLoadDuration: number | null
  translationDuration: number | null
  translationQueueWait: number | null
  cueFinalizationDuration: number | null
  provisionalCueCount: number
  finalCueCount: number
  mergedCueCount: number
  ttsQueuedCount: number
  ttsSkippedProvisional: number
  ttsDeduplicatedCount: number
  /** Señal de completitud Gemma (misma inferencia que translate). */
  gemmaCompletionCalls: number
  gemmaCompleteCount: number
  gemmaIncompleteCount: number
  gemmaCompletionConfidence: number | null
  gemmaCompletionLatency: number | null
  /** Conteos por reason de resolveBoundaryDecision. */
  boundaryDecisionReasons: Record<string, number>
}

export class PipelineMetrics {
  translationEngine = "none"
  modelLoadDuration: number | null = null
  translationDuration: number | null = null
  translationQueueWait: number | null = null
  cueFinalizationDuration: number | null = null
  provisionalCueCount = 0
  finalCueCount = 0
  mergedCueCount = 0
  ttsQueuedCount = 0
  ttsSkippedProvisional = 0
  ttsDeduplicatedCount = 0
  gemmaCompletionCalls = 0
  gemmaCompleteCount = 0
  gemmaIncompleteCount = 0
  gemmaCompletionConfidence: number | null = null
  gemmaCompletionLatency: number | null = null
  boundaryDecisionReasons: Record<string, number> = {}

  reset() {
    this.translationEngine = "none"
    this.modelLoadDuration = null
    this.translationDuration = null
    this.translationQueueWait = null
    this.cueFinalizationDuration = null
    this.provisionalCueCount = 0
    this.finalCueCount = 0
    this.mergedCueCount = 0
    this.ttsQueuedCount = 0
    this.ttsSkippedProvisional = 0
    this.ttsDeduplicatedCount = 0
    this.gemmaCompletionCalls = 0
    this.gemmaCompleteCount = 0
    this.gemmaIncompleteCount = 0
    this.gemmaCompletionConfidence = null
    this.gemmaCompletionLatency = null
    this.boundaryDecisionReasons = {}
  }

  recordBoundaryReason(reason: string) {
    const key = reason || "unknown"
    this.boundaryDecisionReasons[key] =
      (this.boundaryDecisionReasons[key] || 0) + 1
  }

  recordGemmaCompleteness(opts: {
    complete: boolean | null
    confidence: number
    latencyMs: number
  }) {
    this.gemmaCompletionCalls += 1
    this.gemmaCompletionLatency = opts.latencyMs
    if (opts.complete === true) {
      this.gemmaCompleteCount += 1
      this.gemmaCompletionConfidence = opts.confidence
    } else if (opts.complete === false) {
      this.gemmaIncompleteCount += 1
      this.gemmaCompletionConfidence = opts.confidence
    }
  }

  snapshot(): PipelineMetricsSnapshot {
    return {
      translationEngine: this.translationEngine,
      modelLoadDuration: this.modelLoadDuration,
      translationDuration: this.translationDuration,
      translationQueueWait: this.translationQueueWait,
      cueFinalizationDuration: this.cueFinalizationDuration,
      provisionalCueCount: this.provisionalCueCount,
      finalCueCount: this.finalCueCount,
      mergedCueCount: this.mergedCueCount,
      ttsQueuedCount: this.ttsQueuedCount,
      ttsSkippedProvisional: this.ttsSkippedProvisional,
      ttsDeduplicatedCount: this.ttsDeduplicatedCount,
      gemmaCompletionCalls: this.gemmaCompletionCalls,
      gemmaCompleteCount: this.gemmaCompleteCount,
      gemmaIncompleteCount: this.gemmaIncompleteCount,
      gemmaCompletionConfidence: this.gemmaCompletionConfidence,
      gemmaCompletionLatency: this.gemmaCompletionLatency,
      boundaryDecisionReasons: { ...this.boundaryDecisionReasons },
    }
  }
}

export const pipelineMetrics = new PipelineMetrics()
