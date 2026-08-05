/**
 * Colas ASR y traducción con concurrencia 1 y solapamiento entre etapas.
 * La captura de audio nunca espera a estas colas: solo encola y sigue.
 */

export type AudioChunkJob = {
  chunkId: number
  /** performance.now() cuando se cerró el chunk de audio. */
  audioCapturedAt: number
  pcm: Float32Array
  seconds: number
  language: string | null
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
  asrStartedAt: number
  asrFinishedAt: number
}

type QueueOptions<T> = {
  maxPending: number
  /** Si true, al superar maxPending se descarta lo más antiguo. */
  dropOldest: boolean
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
      while (pending.length > options.maxPending) {
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
  }
}
