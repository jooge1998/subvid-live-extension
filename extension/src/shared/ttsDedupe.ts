/**
 * Evita TTS duplicado: cueId estable + firma normalizada del texto.
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

  reset() {
    this.cueIds.clear()
    this.signatures.clear()
    this.deduplicatedCount = 0
  }

  /** true si ya se envió este cue/texto al TTS. */
  alreadySpoken(cueId: string, text: string): boolean {
    const sig = normalizeForDeduplication(text)
    if (!sig) return true
    if (cueId && this.cueIds.has(cueId)) return true
    if (this.signatures.has(sig)) return true
    return false
  }

  markSpoken(cueId: string, text: string): void {
    const sig = normalizeForDeduplication(text)
    if (cueId) this.cueIds.add(cueId)
    if (sig) this.signatures.add(sig)
  }

  /**
   * Intenta marcar y devolver si debe hablarse.
   * return false → saltar (duplicado).
   */
  trySpeak(cueId: string, text: string): boolean {
    if (this.alreadySpoken(cueId, text)) {
      this.deduplicatedCount += 1
      return false
    }
    this.markSpoken(cueId, text)
    return true
  }

  deduplicatedCount = 0

  get size() {
    return this.cueIds.size
  }

  getDeduplicatedCount() {
    return this.deduplicatedCount
  }
}
