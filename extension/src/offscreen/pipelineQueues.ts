/**
 * Colas ASR y traducción con concurrencia 1 y solapamiento entre etapas.
 * La captura de audio nunca espera a estas colas: solo encola y sigue.
 */

export type AudioChunkJob = {
  chunkId: number
  /** Date.now() cuando empezó la voz de este fragmento. */
  audioCapturedAt: number
  /** Date.now() cuando se cerró el chunk y se encoló. */
  chunkCreatedAt: number
  pcm: Float32Array
  seconds: number
  language: string | null
  /** Silencio trailing al cerrar el chunk (segundos). */
  silenceDurationSeconds: number
}

export type TranslationJob = {
  chunkId: number
  cueId: string
  /** Generación del cue: si el ASR fusionó texto, sube y las traducciones viejas se ignoran. */
  generation: number
  text: string
  previousContext: string[]
  sourceLang: string
  targetLang: string
  seconds: number
  audioCapturedAt: number
  chunkCreatedAt: number
  asrStartedAt: number
  asrFinishedAt: number
  /** Heurística ASR/pending (puede subir a FINAL tras Gemma.complete). */
  isFinal: boolean
  boundaryReason?: string
  boundaryConfidence?: number
  fragmentStartedAt?: number
  /** Señales para resolveBoundaryDecision tras la traducción. */
  silenceDurationSeconds?: number
  isWhisperStable?: boolean
  flushedByLimit?: boolean
  pendingAgeMs?: number
  pendingCueCount?: number
  heuristicComplete?: boolean
}

type QueueOptions<T> = {
  maxPending: number | (() => number)
  /** Si true, al superar maxPending se descarta lo más antiguo. */
  dropOldest: boolean
}

function resolveMaxPending(maxPending: number | (() => number)) {
  return typeof maxPending === "function" ? maxPending() : maxPending
}

/**
 * Procesador serial (concurrency 1) con cola acotada.
 * `process` se invoca de uno en uno; errores no detienen la cola.
 */
export function createSerialQueue<T>(
  process: (item: T) => Promise<void>,
  options: QueueOptions<T>,
) {
  const pending: T[] = []
  let running = false
  let active = true

  async function pump() {
    if (running) return
    running = true
    try {
      while (active && pending.length) {
        const next = pending.shift()!
        try {
          await process(next)
        } catch (error) {
          console.error("[subvid:queue] job failed", error)
        }
      }
    } finally {
      running = false
    }
  }

  return {
    enqueue(item: T) {
      if (!active) return
      pending.push(item)
      const max = Math.max(1, resolveMaxPending(options.maxPending))
      while (pending.length > max) {
        if (options.dropOldest) pending.shift()
        else pending.pop()
      }
      void pump()
    },
    clear() {
      pending.length = 0
    },
    stop() {
      active = false
      pending.length = 0
    },
    get size() {
      return pending.length
    },
    get busy() {
      return running
    },
    /** Espera a que la cola quede vacía e idle (o timeout). */
    async idle(timeoutMs = 4_000) {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while (pending.length > 0 || running) {
        if (Date.now() >= deadline) return false
        await new Promise((r) => setTimeout(r, 40))
      }
      return true
    },
  }
}
