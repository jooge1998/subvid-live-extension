/**
 * Estabilidad de hipótesis ASR para evitar parpadeos del overlay.
 * No bloquea actualizaciones: solo indica cuándo un cue es “definitivo”.
 */

export type StabilityResult = {
  /** 0..1 — qué tan estable está el texto actual. */
  stabilityScore: number
  /** true cuando el texto se considera definitivo. */
  isFinal: boolean
}

type CueStabilityState = {
  text: string
  score: number
  /** Veces consecutivas con el mismo texto normalizado. */
  unchangedCount: number
}

const STABLE_THRESHOLD = 0.85
const UNCHANGED_TO_FINAL = 2

function normalize(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ")
}

function wordCount(text: string) {
  const t = text.trim()
  if (!t) return 0
  return t.split(/\s+/).length
}

/**
 * Compara texto nuevo vs el almacenado del cue.
 * - Prefijo + palabras nuevas → sube estabilidad.
 * - Cambio total → baja.
 * - Texto idéntico repetido → marca final.
 */
export function computeCueStability(
  previous: CueStabilityState | null,
  nextText: string,
): StabilityResult & { state: CueStabilityState } {
  const next = normalize(nextText)
  if (!next) {
    return {
      stabilityScore: 0,
      isFinal: false,
      state: { text: "", score: 0, unchangedCount: 0 },
    }
  }

  if (!previous || !previous.text) {
    const state = { text: next, score: 0.35, unchangedCount: 1 }
    return { stabilityScore: state.score, isFinal: false, state }
  }

  const prev = previous.text

  if (next === prev) {
    const unchangedCount = previous.unchangedCount + 1
    const score = Math.min(1, previous.score + 0.25)
    const isFinal =
      unchangedCount >= UNCHANGED_TO_FINAL || score >= STABLE_THRESHOLD
    const state = { text: next, score, unchangedCount }
    return { stabilityScore: score, isFinal, state }
  }

  // Extensión: mismo prefijo, solo crece (o se acorta levemente manteniendo prefijo).
  const isExtension =
    next.startsWith(prev) ||
    (prev.startsWith(next) && wordCount(prev) - wordCount(next) <= 2)

  if (isExtension) {
    const added = Math.abs(wordCount(next) - wordCount(prev))
    const bump = added <= 3 ? 0.18 : 0.1
    const score = Math.min(0.95, previous.score + bump)
    const state = {
      text: next.length >= prev.length ? next : prev,
      score,
      unchangedCount: 0,
    }
    return {
      stabilityScore: score,
      isFinal: score >= STABLE_THRESHOLD,
      state,
    }
  }

  // Hipótesis distinta: bajar estabilidad.
  const score = Math.max(0.1, previous.score * 0.35)
  const state = { text: next, score, unchangedCount: 0 }
  return { stabilityScore: score, isFinal: false, state }
}

/** Al confirmar traducción (o fin de chunk sin más ASR), forzar final. */
export function markCueFinal(
  previous: CueStabilityState | null,
  text: string,
): StabilityResult & { state: CueStabilityState } {
  const state = {
    text: normalize(text) || previous?.text || "",
    score: 1,
    unchangedCount: Math.max(previous?.unchangedCount ?? 0, UNCHANGED_TO_FINAL),
  }
  return { stabilityScore: 1, isFinal: true, state }
}

export type { CueStabilityState }
