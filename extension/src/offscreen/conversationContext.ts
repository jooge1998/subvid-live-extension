/**
 * Contexto corto de conversación para traducción en vivo.
 * Mantiene últimos cues + nombres propios / términos recurrentes
 * sin inflar el payload (límite estricto de tokens/frases).
 */

import { TRANSLATION_CONTEXT_CUES } from "./chunkConfig.ts"

const MAX_PROPER_NOUNS = 6
const MAX_CONTEXT_CHARS = 280

/** Heurística ligera: palabras Capitalizadas que no empiezan la frase. */
function extractProperNouns(text: string): string[] {
  const words = text.match(/\b[\p{L}][\p{L}'’-]*\b/gu) || []
  const found: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.length < 2) continue
    if (
      /^[\p{Lu}]/u.test(w) &&
      !/^(I|A|The|An|El|La|Los|Las|Un|Una)$/u.test(w)
    ) {
      if (i === 0) continue
      found.push(w)
    }
  }
  return found
}

export class ConversationContextManager {
  private recent: string[] = []
  private properNouns = new Map<string, number>()
  private maxCues = TRANSLATION_CONTEXT_CUES

  setMaxCues(n: number) {
    this.maxCues = Math.max(1, Math.min(5, n))
    while (this.recent.length > this.maxCues) this.recent.shift()
  }

  reset() {
    this.recent = []
    this.properNouns.clear()
  }

  push(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return

    const last = this.recent[this.recent.length - 1]
    if (last && (trimmed.startsWith(last) || last.startsWith(trimmed))) {
      this.recent[this.recent.length - 1] =
        trimmed.length >= last.length ? trimmed : last
    } else if (last !== trimmed) {
      this.recent.push(trimmed)
    }

    while (this.recent.length > this.maxCues) {
      this.recent.shift()
    }

    for (const name of extractProperNouns(trimmed)) {
      const key = name.toLowerCase()
      this.properNouns.set(key, (this.properNouns.get(key) || 0) + 1)
    }

    if (this.properNouns.size > MAX_PROPER_NOUNS * 2) {
      const ranked = [...this.properNouns.entries()].sort((a, b) => b[1] - a[1])
      this.properNouns = new Map(ranked.slice(0, MAX_PROPER_NOUNS))
    }
  }

  updateLatest(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!this.recent.length) {
      this.push(trimmed)
      return
    }
    this.recent[this.recent.length - 1] = trimmed
    for (const name of extractProperNouns(trimmed)) {
      const key = name.toLowerCase()
      this.properNouns.set(key, (this.properNouns.get(key) || 0) + 1)
    }
  }

  getContextFor(current: string): string[] {
    const cues = this.recent
      .filter((t) => t !== current.trim())
      .slice(-this.maxCues)

    const nouns = [...this.properNouns.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PROPER_NOUNS)
      .map(([key]) => {
        for (let i = this.recent.length - 1; i >= 0; i--) {
          const match = this.recent[i].match(
            new RegExp(`\\b(${key[0].toUpperCase()}${key.slice(1)})\\b`, "i"),
          )
          if (match) return match[1]
        }
        return key[0].toUpperCase() + key.slice(1)
      })

    const parts: string[] = [...cues]
    if (nouns.length) {
      parts.push(`Names: ${nouns.join(", ")}`)
    }

    let total = 0
    const limited: string[] = []
    for (const part of parts) {
      if (total + part.length > MAX_CONTEXT_CHARS) break
      limited.push(part)
      total += part.length + 1
    }
    return limited
  }
}

export const conversationContext = new ConversationContextManager()
