/**
 * Evita TTS duplicado: cueId + generation + firma normalizada del texto.
 * Solo el caller debe invocar trySpeak en cues FINAL.
 */

export function normalizeForDeduplication(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‛]/g, "'")
    .replace(/[…]/g, "...")
    .replace(/[.!?¡¿,;:]+/g, " ")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export class SpokenCueTracker {
  private cueIds = new Set<string>()
  private signatures = new Set<string>()
  /** Última generation hablada por cueId (TTS ligado a revisión FINAL). */
  private cueGenerations = new Map<string, number>()
  deduplicatedCount = 0

  reset() {
    this.cueIds.clear()
    this.signatures.clear()
    this.cueGenerations.clear()
    this.deduplicatedCount = 0
  }

  /** true si ya se envió este cue/texto al TTS. */
  alreadySpoken(cueId: string, text: string, generation?: number): boolean {
    const sig = normalizeForDeduplication(text)
    if (!sig) return true
    if (generation != null && cueId) {
      const prev = this.cueGenerations.get(cueId)
      if (prev != null && generation < prev) return true
      if (prev === generation && this.cueIds.has(cueId)) return true
    } else if (cueId && this.cueIds.has(cueId)) {
      return true
    }
    if (this.signatures.has(sig)) return true
    return false
  }

  markSpoken(cueId: string, text: string, generation?: number): void {
    const sig = normalizeForDeduplication(text)
    if (cueId) this.cueIds.add(cueId)
    if (sig) this.signatures.add(sig)
    if (cueId && generation != null) {
      const prev = this.cueGenerations.get(cueId) ?? 0
      this.cueGenerations.set(cueId, Math.max(prev, generation))
    }
  }

  /**
   * Intenta marcar y devolver si debe hablarse.
   * - Misma generation / texto → skip
   * - Generation mayor del mismo cueId → permite (reemplaza utterance)
   * return false → saltar (duplicado).
   */
  trySpeak(cueId: string, text: string, generation?: number): boolean {
    if (this.alreadySpoken(cueId, text, generation)) {
      this.deduplicatedCount += 1
      return false
    }
    // Generation más nueva: permitir re-hablar aunque el cueId ya existiera
    // con una FINAL temprana incorrecta (speakTranslation corta la anterior).
    if (
      generation != null &&
      cueId &&
      this.cueIds.has(cueId) &&
      (this.cueGenerations.get(cueId) ?? 0) < generation
    ) {
      this.markSpoken(cueId, text, generation)
      return true
    }
    this.markSpoken(cueId, text, generation)
    return true
  }

  get size() {
    return this.cueIds.size
  }

  getDeduplicatedCount() {
    return this.deduplicatedCount
  }
}
