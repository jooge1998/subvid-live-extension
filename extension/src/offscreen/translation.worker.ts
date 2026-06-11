// Worker de traducción local con transformers.js (MarianMT o NLLB),
// adaptado de src/scripts/translation.worker.ts de la web.
//
// Protocolo:
//   → { id, type: "ensure-translation", payload: { model } }
//   → { id, type: "translate", payload: { texts, src?, tgt? } }
//   ← { type: "progress", key: "translation", payload }
//   ← { id, type: "done", result? }
//   ← { id, type: "error", error }

import { env, pipeline } from "@huggingface/transformers"

env.allowLocalModels = false
env.useBrowserCache = true

const onnxWasm = (env.backends as any)?.onnx?.wasm
if (onnxWasm) {
  onnxWasm.wasmPaths = `${self.location.origin}/wasm/`
  onnxWasm.numThreads = 1
}

let translator: any = null
let translatorModel = ""

const post = (msg: any) => (self as any).postMessage(msg)

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === "ensure-translation") {
      if (!translator || translatorModel !== payload.model) {
        translator = await pipeline("translation", payload.model, {
          progress_callback: (p: any) =>
            post({ type: "progress", key: "translation", payload: p }),
        })
        translatorModel = payload.model
      }
      post({ id, type: "done" })
    } else if (type === "translate") {
      if (!translator) throw new Error("Translation model is not loaded")
      const options =
        payload.src && payload.tgt
          ? { src_lang: payload.src, tgt_lang: payload.tgt }
          : undefined
      const result = options
        ? await translator(payload.texts, options)
        : await translator(payload.texts)
      post({ id, type: "done", result })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` })
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) })
  }
}
