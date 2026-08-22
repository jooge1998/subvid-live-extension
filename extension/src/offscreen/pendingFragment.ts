/**
 * Fragmento lingüístico pendiente: une cues ASR cortos de la misma idea
 * sin concatenar indiscriminadamente todo el historial.
 */

import {
  analyzeBoundary,
  type BoundaryReason,
  type BoundaryResult,
} from "./sentenceBoundaryDetector.ts"

/** Antes ~8s: en clips cortos el TTS llegaba casi al final. */
export const MAX_PENDING_FRAGMENT_MS = 3_500
export const MAX_PENDING_FRAGMENT_CHARS = 160
export const MAX_PENDING_FRAGMENT_CUES = 3

export type FragmentIngestMeta = {
  silenceDuration: number
  audioDuration: number
  asrConfidence?: number
  isWhisperStable?: boolean
  silenceClearSeconds?: number
  nowMs?: number
  debug?: boolean
}

export type FragmentIngestResult = {
  /** Texto acumulado a mostrar / traducir. */
  text: string
  /** true → unidad lista para FINAL + TTS. */
  isFinal: boolean
  boundary: BoundaryResult
  cueCount: number
  merged: boolean
  flushedByLimit: boolean
  pendingAgeMs: number
}

type PendingState = {
  text: string
  startedAt: number
  cueCount: number
  totalAudioSeconds: number
}

function mergeTexts(previous: string, next: string): string {
  const a = previous.trim()
  const b = next.trim()
  if (!a) return b
  if (!b) return a
  if (b.startsWith(a) || a.startsWith(b)) {
    return b.length >= a.length ? b : a
  }
  // Continuación típica: "I think" + "we should" → "I think we should"
  const aWords = a.toLowerCase().split(/\s+/)
  const bWords = b.toLowerCase().split(/\s+/)
  let overlap = 0
  const max = Math.min(aWords.length, bWords.length)
  for (let k = max; k >= 1; k--) {
    if (aWords.slice(-k).join(" ") === bWords.slice(0, k).join(" ")) {
      overlap = k
      break
    }
  }
  if (overlap > 0) {
    return `${a} ${b.split(/\s+/).slice(overlap).join(" ")}`.replace(/\s+/g, " ").trim()
  }
  return `${a} ${b}`.replace(/\s+/g, " ").trim()
}

export class PendingFragmentManager {
  private pending: PendingState | null = null

  reset() {
    this.pending = null
  }

  get text() {
    return this.pending?.text || ""
  }

  ingest(nextText: string, meta: FragmentIngestMeta): FragmentIngestResult {
    const now = meta.nowMs ?? Date.now()
    const incoming = nextText.trim()
    if (!incoming) {
      const age = this.pending ? now - this.pending.startedAt : 0
      return {
        text: this.pending?.text || "",
        isFinal: false,
        boundary: {
          isLikelyComplete: false,
          confidence: 0.9,
          reason: "grammatical_fragment",
        },
        cueCount: this.pending?.cueCount || 0,
        merged: false,
        flushedByLimit: false,
        pendingAgeMs: age,
      }
    }

    let merged = false
    if (!this.pending) {
      this.pending = {
        text: incoming,
        startedAt: now,
        cueCount: 1,
        totalAudioSeconds: meta.audioDuration,
      }
    } else {
      const combined = mergeTexts(this.pending.text, incoming)
      merged = combined !== incoming || this.pending.cueCount > 0
      this.pending = {
        text: combined,
        startedAt: this.pending.startedAt,
        cueCount: this.pending.cueCount + 1,
        totalAudioSeconds: this.pending.totalAudioSeconds + meta.audioDuration,
      }
    }

    const ageMs = now - this.pending.startedAt
    let forceReason: BoundaryReason | undefined
    let flushedByLimit = false

    if (ageMs >= MAX_PENDING_FRAGMENT_MS) {
      forceReason = "max_segment_duration"
      flushedByLimit = true
    } else if (this.pending.text.length >= MAX_PENDING_FRAGMENT_CHARS) {
      forceReason = "max_fragment_length"
      flushedByLimit = true
    } else if (this.pending.cueCount >= MAX_PENDING_FRAGMENT_CUES) {
      forceReason = "max_fragment_length"
      flushedByLimit = true
    }

    const boundary = analyzeBoundary({
      text: this.pending.text,
      previousText: incoming,
      silenceDuration: meta.silenceDuration,
      audioDuration: this.pending.totalAudioSeconds,
      asrConfidence: meta.asrConfidence,
      isWhisperStable: meta.isWhisperStable,
      silenceClearSeconds: meta.silenceClearSeconds,
      maxSegmentSeconds: 4,
      forceComplete: flushedByLimit,
      forceReason,
      debug: meta.debug,
    })

    const isFinal = boundary.isLikelyComplete
    const snapshot = this.pending.text
    const cueCount = this.pending.cueCount

    if (isFinal) {
      this.pending = null
    }

    return {
      text: snapshot,
      isFinal,
      boundary,
      cueCount,
      merged,
      flushedByLimit,
      pendingAgeMs: ageMs,
    }
  }

  /** Cierra el fragmento pendiente aunque el boundary diga provisional. */
  flush(reason: BoundaryReason = "max_segment_duration"): FragmentIngestResult | null {
    if (!this.pending) return null
    const text = this.pending.text
    const cueCount = this.pending.cueCount
    const pendingAgeMs = Date.now() - this.pending.startedAt
    this.pending = null
    return {
      text,
      isFinal: true,
      boundary: {
        isLikelyComplete: true,
        confidence: 0.95,
        reason,
      },
      cueCount,
      merged: cueCount > 1,
      flushedByLimit: true,
      pendingAgeMs,
    }
  }
}

export const pendingFragment = new PendingFragmentManager()
