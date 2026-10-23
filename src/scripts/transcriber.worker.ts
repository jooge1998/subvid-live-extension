// Dedicated Web Worker that hosts the Whisper ASR transformers.js pipeline.
// Loading and running inference is heavy CPU/WASM work that would otherwise
// freeze the main thread (the UI, progress bars, etc.).
//
// Protocol (main ⇄ worker):
//   → { id, type: "ensure-asr", payload: { model, webgpu } }
//   → { id, type: "transcribe", payload: { audio, language, wordTimestamps } }
//                                                             // audio buffer transferred
//   ← { type: "progress", key, payload }   // streamed model-download progress
//   ← { type: "chunk" }                     // streamed per-chunk ASR progress
//   ← { id, type: "done", result? }         // request finished
//   ← { id, type: "error", error }          // request failed

import { env, pipeline, Tensor } from "@huggingface/transformers";
import { LANGS } from "@/scripts/languages.ts";

env.allowLocalModels = false;
env.useBrowserCache = true;

type Device = "webgpu" | "wasm";

// Measured on whisper-base (3 min of audio, Apple M-series):
//   - WebGPU, fp16 encoder + q4f16 decoder: 110 MB download, ~2x faster than CPU.
//   - CPU, q8: 77 MB download (vs 291 MB for fp32) with the same accuracy.
// q4 is avoided on the CPU: its MatMulNBits weights trigger an ONNX Runtime
// WASM bug ("TransposeDQWeightsForMatMulNBits Missing required scale").
const DTYPES = {
  webgpu: { encoder_model: "fp16", decoder_model_merged: "q4f16" },
  wasm: "q8",
} as const;

let recognizer: any = null;
let recognizerDevice: Device = "wasm";
let loading: Promise<void> | null = null;
let runtimeConfigured = false;

const post = (msg: any, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer);

// Firefox's WebGPU stalls ONNX Runtime's decoding loop: on Firefox 158 (macOS)
// Whisper hangs after detecting the language for anything longer than a few
// seconds, with fp32 and fp16 alike. Its WASM path works, so it stays there.
const IS_FIREFOX = /firefox/i.test(navigator.userAgent);

async function preferredDevice(): Promise<Device> {
  if (IS_FIREFOX) return "wasm";
  const gpu = (navigator as any).gpu;
  const adapter = await gpu?.requestAdapter?.().catch(() => null);
  return adapter?.features?.has("shader-f16") ? "webgpu" : "wasm";
}

// ONNX Runtime loads its WASM binary once per worker. Without WebGPU, the
// plain build is enough and ~12 MB smaller than the default "asyncify" one
// (transformers.js uses it too on Safari without WebGPU).
function configureRuntime(device: Device) {
  if (runtimeConfigured) return;
  runtimeConfigured = true;
  const onnx = env.backends.onnx as any;
  const version = onnx?.versions?.web;
  if (device !== "wasm" || !version || !onnx.wasm) return;
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
  onnx.wasm.wasmPaths = {
    mjs: `${base}ort-wasm-simd-threaded.mjs`,
    wasm: `${base}ort-wasm-simd-threaded.wasm`,
  };
}

async function loadRecognizer(model: string, device: Device) {
  configureRuntime(device);
  console.info(`[ASR] loading Whisper model (${device})`);
  recognizer = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype: DTYPES[device] as any,
    progress_callback: (p: any) =>
      post({ type: "progress", key: "asr", payload: p }),
  });
  console.info(`[ASR] Whisper model loaded (${device})`);
}

// Requests may arrive while the model is still loading (e.g. right after the
// client restarts this worker), so they all share the same load.
function ensureRecognizer(payload: any) {
  loading ??= (async () => {
    recognizerDevice = payload.forceWasm ? "wasm" : await preferredDevice();
    await loadRecognizer(payload.model, recognizerDevice);
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

// transformers.js doesn't implement Whisper's language detection and falls
// back to English, which turns non-English speech into an English translation.
// This does what Whisper does: one decoder step after <|startoftranscript|>
// over the first 30 s, keeping the most likely language token among the ones
// the app offers (otherwise ambiguous audio can land on e.g. Basque, which the
// editor can't label or translate).
async function detectLanguage(audio: Float32Array): Promise<string | null> {
  const { model, processor } = recognizer;
  const config = model.generation_config;
  const langToId: Record<string, number> | undefined = config?.lang_to_id;
  if (!langToId) return null;

  const { input_features } = await processor(audio.subarray(0, 30 * 16000));
  const decoder_input_ids = new Tensor(
    "int64",
    BigInt64Array.from([BigInt(config.decoder_start_token_id)]),
    [1, 1],
  );
  const { logits } = await model({ input_features, decoder_input_ids });
  const scores = (logits.type === "float32" ? logits : logits.to("float32"))
    .data as Float32Array;

  const ranked = Object.entries(langToId)
    .map(([token, id]) => ({ lang: token.slice(2, -2), score: scores[id] }))
    .filter(({ lang }) => lang in LANGS)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const weights = ranked.map((r) => Math.exp(r.score - ranked[0].score));
  const total = weights.reduce((sum, w) => sum + w, 0);
  console.info(
    "[ASR] detected language",
    ranked
      .slice(0, 3)
      .map((r, i) => `${r.lang} ${Math.round((weights[i] / total) * 100)}%`)
      .join(", "),
  );
  return ranked[0].lang;
}

async function transcribe(payload: any) {
  const language =
    payload.language || (await detectLanguage(payload.audio)) || null;
  const output = await recognizer(payload.audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: payload.wordTimestamps ? "word" : true,
    language,
    chunk_callback: () => post({ type: "chunk" }),
  });
  return { ...output, language };
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === "ensure-asr") {
      await ensureRecognizer(payload);
      post({ id, type: "done", result: { device: recognizerDevice } });
    } else if (type === "transcribe") {
      await loading;
      if (!recognizer) throw new Error("Whisper model is not loaded");
      post({ id, type: "done", result: await transcribe(payload) });
    } else {
      post({ id, type: "error", error: `Unknown message type: ${type}` });
    }
  } catch (err: any) {
    // A failed WebGPU attempt leaves ONNX Runtime unable to start WASM in this
    // worker, so the client replaces it with a fresh one pinned to WASM.
    post({
      id,
      type: "error",
      error: String(err?.message || err),
      gpuFailed: recognizerDevice === "webgpu",
    });
  }
};
