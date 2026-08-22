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
  /** Textos completos recientes para detectar "frase corta → extensión". */
  private recentTexts: Array<{ cueId: string; normalized: string }> = []
  /** Última generation hablada por cueId (TTS ligado a revisión FINAL). */
  private cueGenerations = new Map<string, number>()
  deduplicatedCount = 0

  reset() {
    this.cueIds.clear()
    this.signatures.clear()
    this.cueGenerations.clear()
    this.recentTexts = []
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
    if (sig) {
      this.recentTexts.push({ cueId, normalized: sig })
      if (this.recentTexts.length > 24) this.recentTexts.shift()
    }
  }

  /**
   * Devuelve exactamente lo que debe entrar a la cola TTS.
   * Si el nuevo FINAL extiende una frase ya encolada/hablada, devuelve solo
   * el sufijo nuevo para que "A" + "A B" se oiga como "A" + "B".
   */
  prepareSpeech(
    cueId: string,
    text: string,
    generation?: number,
  ): string | null {
    const cleaned = text.trim()
    const sig = normalizeForDeduplication(cleaned)
    if (!sig) return null

    if (this.alreadySpoken(cueId, cleaned, generation)) {
      this.deduplicatedCount += 1
      return null
    }

    const currentWords = sig.split(/\s+/)
    for (let i = this.recentTexts.length - 1; i >= 0; i--) {
      const previous = this.recentTexts[i].normalized
      const previousWords = previous.split(/\s+/)

      // La nueva traducción es una extensión exacta de la anterior.
      if (
        previousWords.length >= 3 &&
        currentWords.length > previousWords.length &&
        sig.startsWith(`${previous} `)
      ) {
        const rawWords = cleaned.split(/\s+/)
        const suffix = rawWords.slice(previousWords.length).join(" ").trim()
        this.markSpoken(cueId, cleaned, generation)
        return suffix || null
      }

      // Llegó tarde una versión corta ya cubierta por una versión más larga.
      if (
        currentWords.length >= 3 &&
        previousWords.length > currentWords.length &&
        previous.startsWith(`${sig} `)
      ) {
        this.markSpoken(cueId, cleaned, generation)
        this.deduplicatedCount += 1
        return null
      }
    }

    this.markSpoken(cueId, cleaned, generation)
    return cleaned
  }

  /**
   * Intenta marcar y devolver si debe hablarse.
   * - Misma generation / texto → skip
   * - Generation mayor del mismo cueId → permite (reemplaza utterance)
   * return false → saltar (duplicado).
   */
  trySpeak(cueId: string, text: string, generation?: number): boolean {
    return this.prepareSpeech(cueId, text, generation) != null
  }

  get size() {
    return this.cueIds.size
  }

  getDeduplicatedCount() {
    return this.deduplicatedCount
  }
}
