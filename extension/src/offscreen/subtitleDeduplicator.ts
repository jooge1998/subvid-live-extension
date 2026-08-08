/**
 * Deduplicación de subtítulos en vivo.
 * Evita crear un cue nuevo cuando Whisper reemite una extensión / casi-idéntico
 * del último cue visible.
 *
 * No toca ASR ni traducción: solo decide cueId + confirmed/delta.
 */

export type DedupKind =
  | "identical"
  | "near_identical"
  | "continuation"
  | "new"

export type DedupResult = {
  kind: DedupKind
  /** Reutilizar el cue activo. */
  reuse: boolean
  /** Texto completo a mostrar / traducir. */
  fullText: string
  /** Parte ya vista (estable). */
  confirmedText: string
  /** Parte nueva a resaltar (vacío si identical). */
  deltaText: string
}

export type DedupInput = {
  previousText: string
  nextText: string
}

const MIN_PREFIX_WORDS = 3
const NEAR_IDENTICAL_RATIO = 0.82
/** Conectores frecuentes al retomar una idea cortada. */
const CONTINUATION_STARTERS =
  /^(and|but|or|so|because|that|which|who|when|where|if|then|also|y|pero|porque|que|cuando|donde|si|entonces|también|con|para|por|de|del|la|el|los|las|una|un)\b/i

function looksIncomplete(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // Termina en letra/número o coma/guión → probablemente idea a medias.
  if (/[,;:\-–—]$/.test(t)) return true
  if (!/[.!?…。！？]"?$/.test(t)) return true
  return false
}

function normalizeCompare(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[“”«»„]/g, '"')
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function wordsOf(normalized: string): string[] {
  if (!normalized) return []
  return normalized.split(" ").filter(Boolean)
}

function longestCommonPrefixWords(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** Recorta `full` dejando solo lo que va después del prefijo de `prefix` (por palabras). */
function deltaAfterPrefix(fullDisplay: string, prefixWordCount: number): string {
  const rawWords = fullDisplay.trim().split(/\s+/).filter(Boolean)
  if (prefixWordCount <= 0) return fullDisplay.trim()
  if (prefixWordCount >= rawWords.length) return ""
  return rawWords.slice(prefixWordCount).join(" ")
}

function confirmedFromDisplay(
  previousDisplay: string,
  prefixWordCount: number,
): string {
  const rawWords = previousDisplay.trim().split(/\s+/).filter(Boolean)
  if (prefixWordCount <= 0) return ""
  if (prefixWordCount >= rawWords.length) return previousDisplay.trim()
  return rawWords.slice(0, prefixWordCount).join(" ")
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Compara el texto nuevo con el último cue visible.
 */
export function dedupeSubtitle(input: DedupInput): DedupResult {
  const prev = input.previousText.trim()
  const next = input.nextText.trim()
  if (!next) {
    return {
      kind: "identical",
      reuse: true,
      fullText: prev,
      confirmedText: prev,
      deltaText: "",
    }
  }
  if (!prev) {
    return {
      kind: "new",
      reuse: false,
      fullText: next,
      confirmedText: next,
      deltaText: "",
    }
  }

  const prevN = normalizeCompare(prev)
  const nextN = normalizeCompare(next)

  if (prevN === nextN) {
    return {
      kind: "identical",
      reuse: true,
      fullText: next.length >= prev.length ? next : prev,
      confirmedText: next.length >= prev.length ? next : prev,
      deltaText: "",
    }
  }

  const prevW = wordsOf(prevN)
  const nextW = wordsOf(nextN)
  const prefixLen = longestCommonPrefixWords(prevW, nextW)
  const minWords = Math.min(prevW.length, nextW.length)
  const prefixRatio = minWords === 0 ? 0 : prefixLen / minWords

  // Continuación pura: next empieza por prev (normalizado).
  if (prefixLen >= prevW.length && nextW.length > prevW.length) {
    const delta = deltaAfterPrefix(next, prevW.length)
    return {
      kind: "continuation",
      reuse: true,
      fullText: next,
      confirmedText: prev,
      deltaText: delta,
    }
  }

  // Prev era más largo y next es un acortamiento del mismo cue (hipótesis).
  if (prefixLen >= nextW.length && prevW.length > nextW.length) {
    return {
      kind: "near_identical",
      reuse: true,
      fullText: prev,
      confirmedText: next,
      deltaText: "",
    }
  }

  // Prefijo común largo + next más largo → continuación desde el tronco común
  // (Whisper reescribe el final: "salvar a los ciudadanos" → "salvar la seguridad…").
  if (
    prefixLen >= MIN_PREFIX_WORDS &&
    prefixRatio >= 0.5 &&
    nextW.length > prevW.length
  ) {
    const confirmed = confirmedFromDisplay(prev, prefixLen)
    const delta = deltaAfterPrefix(next, prefixLen)
    return {
      kind: "continuation",
      reuse: true,
      fullText: next,
      confirmedText: confirmed || prev,
      deltaText: delta,
    }
  }

  // Casi idéntico por solapamiento de palabras (mismo mensaje, puntuación distinta).
  const sim = jaccard(prevW, nextW)
  if (sim >= NEAR_IDENTICAL_RATIO) {
    const longer = next.length >= prev.length ? next : prev
    const shorter = longer === next ? prev : next
    let delta = ""
    if (nextW.length > prevW.length && prefixLen >= MIN_PREFIX_WORDS) {
      delta = deltaAfterPrefix(next, prefixLen)
    }
    return {
      kind: "near_identical",
      reuse: true,
      fullText: longer,
      confirmedText: shorter,
      deltaText: delta,
    }
  }

  // next contiene prev como subcadena (puntuación / mayúsculas).
  if (nextN.includes(prevN) && nextN.length > prevN.length + 2) {
    const idx = next.toLowerCase().indexOf(prev.toLowerCase().slice(0, 24))
    const delta = deltaAfterPrefix(next, prevW.length)
    return {
      kind: "continuation",
      reuse: true,
      fullText: next,
      confirmedText: prev,
      deltaText: delta || next.slice(Math.max(0, idx) + prev.length).trim(),
    }
  }

  // Idea incompleta: el cue anterior no cerró con puntuación final.
  // Fusionar si hay solape razonable o el nuevo empieza como continuación.
  if (looksIncomplete(prev)) {
    const softPrefix = prefixLen >= 2 && prefixRatio >= 0.35
    const starter = CONTINUATION_STARTERS.test(next.trim())
    const softSim = sim >= 0.45
    if ((softPrefix || starter || softSim) && nextW.length >= prevW.length) {
      const confirmed =
        prefixLen >= 2 ? confirmedFromDisplay(prev, prefixLen) : prev
      const delta =
        prefixLen >= 2 ? deltaAfterPrefix(next, prefixLen) : next.trim()
      return {
        kind: "continuation",
        reuse: true,
        fullText: next,
        confirmedText: confirmed,
        deltaText: delta === next.trim() ? delta : delta,
      }
    }
    // Aunque no haya prefijo: concatenar si el anterior quedó a medias y el
    // nuevo no parece frase independiente (minúscula / conector).
    if (starter || /^[a-záéíóúñü]/.test(next.trim())) {
      const joined = `${prev.replace(/[,;:\s]+$/, "")} ${next.trim()}`
      return {
        kind: "continuation",
        reuse: true,
        fullText: joined,
        confirmedText: prev,
        deltaText: next.trim(),
      }
    }
  }

  return {
    kind: "new",
    reuse: false,
    fullText: next,
    confirmedText: next,
    deltaText: "",
  }
}

export class SubtitleDeduplicator {
  private lastText = ""
  private lastCueId: string | null = null

  reset() {
    this.lastText = ""
    this.lastCueId = null
  }

  getLastCueId() {
    return this.lastCueId
  }

  getLastText() {
    return this.lastText
  }

  /**
   * Decide si reutilizar el cue activo.
   * `allocateNewCueId` solo se llama cuando kind === "new".
   */
  resolve(
    nextText: string,
    activeCueId: string | null,
    allocateNewCueId: () => string,
  ): DedupResult & { cueId: string } {
    const result = dedupeSubtitle({
      previousText: this.lastText,
      nextText,
    })

    if (result.reuse && activeCueId) {
      this.lastText = result.fullText
      this.lastCueId = activeCueId
      return { ...result, cueId: activeCueId }
    }

    if (result.reuse && this.lastCueId) {
      this.lastText = result.fullText
      return { ...result, cueId: this.lastCueId }
    }

    const cueId = allocateNewCueId()
    this.lastText = result.fullText
    this.lastCueId = cueId
    return {
      ...result,
      reuse: false,
      kind: "new",
      cueId,
      confirmedText: result.fullText,
      deltaText: "",
    }
  }
}

export const subtitleDeduplicator = new SubtitleDeduplicator()
