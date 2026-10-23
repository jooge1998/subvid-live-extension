type WorkerTarget = "asr" | "translation"

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  target: WorkerTarget
  type: string
  // Kept only when nothing was transferred, so the request can be re-sent.
  payload?: unknown
  resendable: boolean
}

type TransformersClientOptions = {
  onProgress?: (key: string, payload: unknown) => void
}

// Thrown for requests that failed on WebGPU and couldn't be re-sent (their
// buffers were transferred). The worker has already been restarted on WASM,
// so callers just need to send the request again.
export class RetryOnCpuError extends Error {
  readonly retryOnCpu = true
}

// A WebGPU job that stops reporting progress for this long is treated as a
// stalled GPU and retried on WASM (chunks normally report every few seconds).
const GPU_STALL_MS = 60_000

const ENSURE_TYPES: Record<WorkerTarget, string> = {
  asr: "ensure-asr",
  translation: "ensure-translation",
}

function spawnWorker(target: WorkerTarget) {
  return target === "asr"
    ? new Worker(new URL("./transcriber.worker.ts", import.meta.url), {
        type: "module",
      })
    : new Worker(new URL("./translation.worker.ts", import.meta.url), {
        type: "module",
      })
}

export function createTransformersClient(options: TransformersClientOptions = {}) {
  // Workers are spawned on first use: each one loads ~550 KB of
  // transformers.js + ONNX Runtime that page visitors may never need.
  const workers: Partial<Record<WorkerTarget, Worker>> = {}
  // Once WebGPU fails inside ONNX Runtime, that worker can't fall back to
  // WASM anymore, so it's replaced by a fresh worker pinned to WASM.
  const forceWasm: Record<WorkerTarget, boolean> = {
    asr: false,
    translation: false,
  }
  const lastEnsure: Partial<Record<WorkerTarget, unknown>> = {}
  const devices: Partial<Record<WorkerTarget, string>> = {}
  const stallTimers: Partial<Record<WorkerTarget, ReturnType<typeof setTimeout>>> = {}
  const pending = new Map<number, PendingRequest>()
  let reqId = 0
  let onChunk: (() => void) | null = null

  function targetFor(type: string): WorkerTarget {
    if (type === "ensure-asr" || type === "transcribe") return "asr"
    if (type === "ensure-translation" || type === "translate")
      return "translation"
    throw new Error(`Unknown transformers call type: ${type}`)
  }

  function getWorker(target: WorkerTarget) {
    let worker = workers[target]
    if (!worker) {
      worker = spawnWorker(target)
      wireWorker(worker, target)
      workers[target] = worker
      // A replacement worker starts empty: reload the model it had.
      if (forceWasm[target] && lastEnsure[target])
        send(ENSURE_TYPES[target], lastEnsure[target]).catch(() => {})
    }
    return worker
  }

  function hasPendingJob(target: WorkerTarget) {
    for (const request of pending.values())
      if (request.target === target && request.type !== ENSURE_TYPES[target])
        return true
    return false
  }

  // (Re)starts the stall timer while a WebGPU job is in flight.
  function watchForStall(target: WorkerTarget) {
    clearTimeout(stallTimers[target])
    if (devices[target] !== "webgpu" || !hasPendingJob(target)) return
    stallTimers[target] = setTimeout(() => {
      if (!hasPendingJob(target)) return
      console.warn(`[transformers] ${target}: WebGPU stalled, using WASM`)
      restartOnCpu(target)
    }, GPU_STALL_MS)
  }

  function restartOnCpu(target: WorkerTarget) {
    clearTimeout(stallTimers[target])
    delete devices[target]
    workers[target]?.terminate()
    delete workers[target]
    forceWasm[target] = true
    const inFlight = [...pending].filter(([, request]) => request.target === target)
    for (const [id, request] of inFlight) {
      pending.delete(id)
      if (request.resendable) {
        send(request.type, request.payload).then(request.resolve, request.reject)
      } else {
        request.reject(new RetryOnCpuError("WebGPU failed, retry on CPU"))
      }
    }
  }

  function wireWorker(worker: Worker, target: WorkerTarget) {
    worker.onmessage = (event) => {
      const { id, type } = event.data || {}
      if (workers[target] === worker) watchForStall(target)
      if (type === "progress") {
        options.onProgress?.(event.data.key, event.data.payload)
        return
      }
      if (type === "chunk") {
        onChunk?.()
        return
      }
      const request = pending.get(id)
      if (!request) return
      if (type === "error" && event.data.gpuFailed && !forceWasm[target]) {
        console.warn(`[transformers] ${target}: WebGPU failed, using WASM`, event.data.error)
        restartOnCpu(target)
        return
      }
      pending.delete(id)
      if (request.type === ENSURE_TYPES[target] && event.data.result?.device)
        devices[target] = event.data.result.device
      if (type === "error") request.reject(new Error(event.data.error))
      else request.resolve(event.data.result)
      watchForStall(target)
    }

    worker.onerror = (event) => {
      for (const [id, request] of pending) {
        if (request.target !== target) continue
        pending.delete(id)
        request.reject(event.error || new Error(event.message))
      }
      if (workers[target] === worker) delete workers[target]
    }
  }

  function send(type: string, payload?: unknown, transfer: Transferable[] = []) {
    const target = targetFor(type)
    if (type === ENSURE_TYPES[target]) lastEnsure[target] = payload
    const message = forceWasm[target]
      ? { ...(payload as object), forceWasm: true }
      : payload
    const worker = getWorker(target)
    const id = ++reqId
    const resendable = transfer.length === 0
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        target,
        type,
        payload: resendable ? payload : undefined,
        resendable,
      })
      try {
        worker.postMessage({ id, type, payload: message }, transfer)
        watchForStall(target)
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
  }

  return {
    call: send,
    setChunkHandler(handler: (() => void) | null) {
      onChunk = handler
    },
  }
}
