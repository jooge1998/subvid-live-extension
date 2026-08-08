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
    }
  }
}

export const pipelineMetrics = new PipelineMetrics()
