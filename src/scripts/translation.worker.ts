// Dedicated Web Worker that hosts local transformers.js translation pipelines.
// It is created lazily so Whisper can be ready at startup without also loading
// translation models into the same worker.
//
// Protocol (main -> worker):
//   -> { id, type: "ensure-translation", payload: { backend, model, webgpu, requireWebGPU, forceWasm?, dtype? } }
//   -> { id, type: "translate", payload: { backend, texts, src?, tgt? } }
//   <- { type: "progress", key, payload }   // streamed model-download progress
//   <- { id, type: "done", result? }         // request finished
//   <- { id, type: "error", error, gpuFailed } // request failed

import { env, pipeline } from "@huggingface/transformers"

env.allowLocalModels = false
env.useBrowserCache = true

let translator: any = null
let translatorModel = ""
let translatorBackend: "marian" | "nllb" | "" = ""
let translatorDevice: "webgpu" | "default" = "default"
let loading: Promise<void> = Promise.resolve()

const post = (msg: any) => (self as any).postMessage(msg)

const progressCallback = (p: any) =>
  post({ type: "progress", key: "translation", payload: p })

// On Firefox's WebGPU, ONNX Runtime decoding is slow: Marian took 18 s on
// Firefox 158 (macOS) for a batch WASM translates in 1.6 s. WASM it is.
const IS_FIREFOX = /firefox/i.test(navigator.userAgent)

async function gpuAdapter() {
  if (IS_FIREFOX) return null
  const gpu = (navigator as any).gpu
  return (await gpu?.requestAdapter?.().catch(() => null)) || null
}

// A failed WebGPU attempt leaves ONNX Runtime unable to start WASM in this
// worker, so WebGPU is only tried when an adapter exists, and a failure is
// reported as `gpuFailed` for the client to retry in a fresh WASM worker.
async function createTranslator(
  backend: "marian" | "nllb",
  model: string,
  preferWebGPU: boolean,
  requireWebGPU: boolean,
  dtypeOverride?: string,
) {
  const baseOptions = { progress_callback: progressCallback }
  const adapter = preferWebGPU ? await gpuAdapter() : null
  const useWebGPU = !!adapter
  translatorDevice = useWebGPU ? "webgpu" : "default"
  if (!useWebGPU && requireWebGPU)
    throw new Error(`WebGPU is required for ${backend} translation`)

  // Explicit devices: transformers.js otherwise picks WebGPU whenever
  // navigator.gpu exists, even when no adapter is available. fp16 halves the
  // WebGPU download (fp32 NLLB alone is 3.5 GB); WASM uses 8-bit weights.
  const dtype =
    dtypeOverride ||
    (useWebGPU ? (adapter.features?.has("shader-f16") ? "fp16" : "fp32") : "q8")
  console.info(
    `[translate] loading ${backend} on ${useWebGPU ? "WebGPU" : "WASM"} (${dtype})`,
  )
  return pipeline("translation", model, {
    ...baseOptions,
    device: useWebGPU ? "webgpu" : "wasm",
    dtype: dtype as any,
  })
}

async function ensureTranslator(
  backend: "marian" | "nllb",
  model: string,
  preferWebGPU: boolean,
  requireWebGPU: boolean,
  dtypeOverride?: string,
) {
  if (translator && translatorBackend === backend && translatorModel === model) return
  translator = await createTranslator(
    backend,
    model,
    preferWebGPU,
    requireWebGPU,
    dtypeOverride,
  )
  translatorBackend = backend
  translatorModel = model
}

async function runTranslation(payload: any) {
  if (!translator) throw new Error("Translation model is not loaded")
  const options =
    payload.src && payload.tgt
      ? {
          src_lang: payload.src,
          tgt_lang: payload.tgt,
          ...(payload.generation || {}),
        }
      : payload.generation || undefined
  return options ? translator(payload.texts, options) : translator(payload.texts)
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === "ensure-translation") {
      loading = ensureTranslator(
        payload.backend || "nllb",
        payload.model,
        !!payload.webgpu && !payload.forceWasm,
        !!payload.requireWebGPU,
        payload.dtype,
      )
      await loading
      post({ id, type: "done", result: { device: translatorDevice } })
    } else if (type === "translate") {
      await loading.catch(() => {})
      post({ id, type: "done", result: await runTranslation(payload) })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` })
    }
  } catch (err: any) {
    post({
      id,
      type: "error",
      error: String(err?.message || err),
      gpuFailed: translatorDevice === "webgpu",
    })
  }
}
