// Worker que aloja el pipeline Whisper de transformers.js, igual que
// src/scripts/transcriber.worker.ts de la web, pero pensado para fragmentos
// cortos de audio en tiempo real.
//
// Protocolo:
//   → { id, type: "ensure-asr", payload: { model, webgpu } }
//   → { id, type: "transcribe", payload: { audio, language } }  // buffer transferido
//   ← { type: "progress", key: "asr", payload }
//   ← { id, type: "done", result? }
//   ← { id, type: "error", error }

import { env, pipeline } from "@huggingface/transformers"

env.allowLocalModels = false
env.useBrowserCache = true

// Binarios de onnxruntime empaquetados con la extensión (ver vite.config.ts).
const onnxWasm = (env.backends as any)?.onnx?.wasm
if (onnxWasm) {
  onnxWasm.wasmPaths = `${self.location.origin}/wasm/`
  // Las páginas de extensión no son crossOriginIsolated: sin SharedArrayBuffer.
  onnxWasm.numThreads = 1
}

let recognizer: any = null
let recognizerModel = ""

const post = (msg: any) => (self as any).postMessage(msg)

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  try {
    if (type === "ensure-asr") {
      if (!recognizer || recognizerModel !== payload.model) {
        const options: any = {
          progress_callback: (p: any) =>
            post({ type: "progress", key: "asr", payload: p }),
        }
        if (payload?.webgpu) options.device = "webgpu"
        recognizer = await pipeline(
          "automatic-speech-recognition",
          payload.model,
          options,
        )
        recognizerModel = payload.model
      }
      post({ id, type: "done" })
    } else if (type === "transcribe") {
      const output = await recognizer(payload.audio, {
        language: payload.language || null,
        task: "transcribe",
      })
      post({ id, type: "done", result: output })
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` })
    }
  } catch (err: any) {
    post({ id, type: "error", error: String(err?.message || err) })
  }
}
