/**
 * Worker TranslateGemma 4B — transformers.js v4 (alias) + WebGPU.
 *
 * Protocolo (requestId = `id`):
 *   → { id, type: "ensure-translategemma", payload: { model, device, dtype } }
 *   → { id, type: "translate", payload: { text, previousContext, sourceLang, targetLang } }
 *   → { id, type: "ping" }
 *   ← { type: "log", message }
 *   ← { type: "progress", key: "translategemma", payload }
 *   ← { id, type: "done", result? }
 *   ← { id, type: "error", error, structured? }
 *
 * IMPORTANTE: no completa frases. Solo traduce el texto recibido.
 * En modo diagnóstico los errores NO se ocultan con fallback.
 */

import { env, pipeline } from "@huggingface/transformers-v4"

env.allowLocalModels = false
env.useBrowserCache = true

const TRANSFORMERS_JS_VERSION = "4.2.0"

const onnxWasm = (env.backends as any)?.onnx?.wasm
if (onnxWasm) {
  onnxWasm.wasmPaths = `${self.location.origin}/wasm-v4/`
  onnxWasm.numThreads = 1
}

let generator: any = null
let loadedModel = ""
let loadedDevice = ""
let loadCount = 0

const post = (msg: any) => (self as any).postMessage(msg)

function log(message: string) {
  console.info(message)
  post({ type: "log", message })
}

function classifyError(err: unknown, backend?: string) {
  const fullError = String((err as Error)?.stack || (err as Error)?.message || err)
  const message = String((err as Error)?.message || err)

  if (
    /out of memory|oom|failed to allocate|enomem|insufficient memory|memory limit|could not allocate|gpu.*memory|vram/i.test(
      fullError,
    )
  ) {
    return {
      code: "MODEL_MEMORY_ERROR",
      message: "Fallo de memoria al cargar o ejecutar el modelo",
      fullError,
      backend,
    }
  }

  const opMatch = fullError.match(
    /(?:Unsupported|unsupported|Unknown|unknown)\s+(?:operator|op(?:erator)?(?:\s+type)?)\s*[:\s]+['"]?([A-Za-z0-9_]+)/i,
  )
  const nodeMatch = fullError.match(
    /(?:node|Node)\s*[:\s]+['"]?([A-Za-z0-9_./-]+)/,
  )
  if (
    opMatch ||
    /MatMulNBits|TransposeDQWeights|Missing required scale|not supported.*op/i.test(
      fullError,
    )
  ) {
    return {
      code: "ONNX_OPERATOR_ERROR",
      message: "Operador ONNX / WebGPU no soportado",
      fullError,
      operator: opMatch?.[1],
      node: nodeMatch?.[1],
      backend,
    }
  }

  if (/webgpu|gpu adapter|requestDevice|requestAdapter/i.test(fullError)) {
    return {
      code: "WEBGPU_DEVICE_ERROR",
      message: "Error de WebGPU",
      fullError,
      backend: backend || "webgpu",
    }
  }

  if (/onnx|ort\.|onnxruntime/i.test(fullError)) {
    return {
      code: "ONNX_RUNTIME_ERROR",
      message: "Error de ONNX Runtime",
      fullError,
      backend,
    }
  }

  return {
    code: "WORKER_ERROR",
    message,
    fullError,
    backend,
  }
}

const SOURCE_LANG_CODES: Record<string, string> = {
  en: "en",
  es: "es",
  fr: "fr",
  de: "de",
  pt: "pt",
  it: "it",
  nl: "nl",
  ru: "ru",
  ja: "ja",
  ko: "ko",
  zh: "zh",
  ar: "ar",
  hi: "hi",
  pl: "pl",
  tr: "tr",
}

/** Códigos que espera el chat template de TranslateGemma (BCP-47). */
const TARGET_LANG_CODES: Record<string, string> = {
  en: "en",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  it: "it-IT",
  nl: "nl-NL",
  ru: "ru-RU",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  ar: "ar",
  hi: "hi-IN",
  pl: "pl-PL",
  tr: "tr-TR",
}

/**
 * Formato oficial TranslateGemma:
 * - Solo roles user/assistant (NO system al inicio → "Conversations must start with a user prompt")
 * - content = [{ type, source_lang_code, target_lang_code, text }]
 */
function buildTranslateGemmaMessages(
  text: string,
  sourceLang: string,
  targetLang: string,
) {
  const src = SOURCE_LANG_CODES[sourceLang] || sourceLang
  const tgt = TARGET_LANG_CODES[targetLang] || targetLang
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          source_lang_code: src,
          target_lang_code: tgt,
          text,
        },
      ],
    },
  ]
}

function extractGenerated(result: any): string {
  if (!result) return ""
  if (typeof result === "string") return result
  const first = Array.isArray(result) ? result[0] : result
  if (typeof first?.generated_text === "string") {
    return first.generated_text
  }
  if (Array.isArray(first?.generated_text)) {
    const msgs = first.generated_text
    for (let i = msgs.length - 1; i >= 0; i--) {
      const last = msgs[i]
      if (typeof last?.content === "string" && last.content.trim()) {
        return last.content
      }
      if (Array.isArray(last?.content)) {
        const parts = last.content
          .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
          .join("")
          .trim()
        if (parts) return parts
      }
      if (typeof last === "string" && last.trim()) return last
    }
  }
  return String(first?.translation_text ?? first?.text ?? "").trim()
}

log(
  `[TranslateGemma] worker boot transformers.js=${TRANSFORMERS_JS_VERSION}`,
)

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data || {}
  const requestId = id
  try {
    if (type === "ping") {
      post({
        id,
        type: "done",
        result: {
          ok: true,
          hasModel: !!generator,
          loadCount,
          transformersJsVersion: TRANSFORMERS_JS_VERSION,
        },
      })
      return
    }

    if (type === "ensure-translategemma") {
      const model = payload?.model
      const device = payload?.device === "webgpu" ? "webgpu" : "wasm"
      const dtype = payload?.dtype || "q4"
      if (!model) throw new Error("model requerido")

      const canReuse =
        !!generator && loadedModel === model && loadedDevice === device

      if (canReuse) {
        log(
          `[TranslateGemma] model already loaded — reusing instance (requestId=${requestId})`,
        )
        post({
          id,
          type: "done",
          result: {
            reused: true,
            loadCount,
            transformersJsVersion: TRANSFORMERS_JS_VERSION,
            device,
            model,
          },
        })
        return
      }

      log(`[TranslateGemma] model loading (requestId=${requestId}) device=${device}`)
      const loadStartedAt = Date.now()
      let lastProgressAt = loadStartedAt
      const heartbeat = setInterval(() => {
        const elapsedSec = Math.round((Date.now() - loadStartedAt) / 1000)
        const sinceProgress = Math.round((Date.now() - lastProgressAt) / 1000)
        log(
          `[TranslateGemma] model loading heartbeat elapsed=${elapsedSec}s sinceLastProgress=${sinceProgress}s (requestId=${requestId})`,
        )
        post({
          type: "progress",
          key: "translategemma",
          payload: {
            status: "heartbeat",
            elapsedSec,
            sinceProgressSec: sinceProgress,
          },
        })
      }, 15_000)

      try {
        generator = await pipeline("text-generation", model, {
          device,
          dtype,
          progress_callback: (p: any) => {
            lastProgressAt = Date.now()
            const file = p?.file ? String(p.file) : ""
            const pct =
              typeof p?.progress === "number" ? Math.round(p.progress) : null
            if (p?.status === "progress" || p?.status === "download") {
              log(
                `[TranslateGemma] download ${file || "file"}${pct != null ? ` ${pct}%` : ""}`,
              )
            } else if (p?.status) {
              log(`[TranslateGemma] progress status=${p.status} ${file}`)
            }
            post({ type: "progress", key: "translategemma", payload: p })
          },
        })
        clearInterval(heartbeat)
        loadedModel = model
        loadedDevice = device
        loadCount += 1
        log(
          `[TranslateGemma] model ready (requestId=${requestId}) loadCount=${loadCount} elapsedMs=${Date.now() - loadStartedAt}`,
        )
        post({
          id,
          type: "done",
          result: {
            reused: false,
            loadCount,
            transformersJsVersion: TRANSFORMERS_JS_VERSION,
            device,
            model,
            loadElapsedMs: Date.now() - loadStartedAt,
          },
        })
      } catch (err) {
        clearInterval(heartbeat)
        log(`[TranslateGemma] worker error (ensure) ${String((err as Error)?.message || err)}`)
        const structured = classifyError(err, device)
        post({
          id,
          type: "error",
          error: structured.message + ": " + structured.fullError,
          structured,
        })
      }
      return
    }

    if (type === "translate") {
      if (!generator) throw new Error("TranslateGemma no está cargado")
      const text = String(payload?.text || "").trim()
      log(`[TranslateGemma] translate start (requestId=${requestId})`)
      if (!text) {
        log(`[TranslateGemma] translate end (requestId=${requestId}) empty`)
        post({ id, type: "done", result: { text: "" } })
        return
      }

      const sourceLang = String(payload?.sourceLang || "en")
      const targetLang = String(payload?.targetLang || "es")
      // TranslateGemma: plantilla nativa (user + source/target lang codes).
      // NO usar role "system" al inicio.
      const messages = buildTranslateGemmaMessages(text, sourceLang, targetLang)
      const maxNew = Math.min(256, Math.max(48, Math.ceil(text.length * 2.5)))

      let result: any
      try {
        result = await generator(messages, {
          max_new_tokens: maxNew,
          do_sample: false,
          temperature: 0,
          return_full_text: false,
        })
      } catch (firstErr) {
        log(
          `[TranslateGemma] chat API failed, trying apply_chat_template: ${String((firstErr as Error)?.message || firstErr)}`,
        )
        try {
          if (typeof generator.tokenizer?.apply_chat_template !== "function") {
            throw firstErr
          }
          const prompt = generator.tokenizer.apply_chat_template(messages, {
            tokenize: false,
            add_generation_prompt: true,
          })
          result = await generator(prompt, {
            max_new_tokens: maxNew,
            do_sample: false,
            temperature: 0,
            return_full_text: false,
          })
        } catch (err) {
          log(
            `[TranslateGemma] worker error (translate) ${String((err as Error)?.message || err)}`,
          )
          const structured = classifyError(err, loadedDevice || "webgpu")
          post({
            id,
            type: "error",
            error: structured.message + ": " + structured.fullError,
            structured,
          })
          return
        }
      }

      const generated = extractGenerated(result)
      log(
        `[TranslateGemma] translate end (requestId=${requestId}) chars=${generated.length} preview=${JSON.stringify(generated.slice(0, 80))}`,
      )
      post({ id, type: "done", result: { text: generated } })
      return
    }

    post({ id, type: "error", error: `Unknown message type: ${type}` })
  } catch (err: any) {
    log(`[TranslateGemma] worker error ${String(err?.message || err)}`)
    const structured = classifyError(err, loadedDevice || "webgpu")
    post({
      id,
      type: "error",
      error: String(err?.message || err),
      structured,
    })
  }
}
