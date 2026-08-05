/**
 * Capa abstracta de traducción en vivo.
 * Cascada: Chrome Translator API → MarianMT → NLLB-200.
 */

import {
  LANGS,
  MARIAN_TRANSLATION_MODELS,
  NLLB_MODEL,
  translationBackendInfo,
} from "../shared/languages.ts"
import type { TranslationBackendInfo } from "../shared/types.ts"
import { glossaryManager } from "./glossary.ts"

export type TranslateInput = {
  text: string
  /** Últimos 2–3 cues originales para continuidad (pronombres, nombres). */
  previousContext: string[]
  sourceLang: string
  targetLang: string
}

export type WorkerClient = {
  call: (
    type: string,
    payload?: unknown,
    transfer?: Transferable[],
    timeoutMs?: number,
  ) => Promise<any>
  terminate: () => void
}

type ProgressFn = (key: string, payload: any) => void
type StatusFn = (phase: string, detail?: string, progress?: number) => void

const MODEL_LOAD_TIMEOUT_MS = 90_000

/** Extrae la última oración de un texto multi-oración (contexto + actual). */
function lastSentence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  const parts = trimmed.split(/(?<=[.!?…。！？])\s+/u).filter(Boolean)
  return (parts[parts.length - 1] || trimmed).trim()
}

export class TranslationProvider {
  private builtinTranslator: any = null
  private translationClient: WorkerClient | null = null
  private translationWorkerOpts: { src?: string; tgt?: string } | null = null
  private backend: TranslationBackendInfo | null = null
  private loadedPair: string | null = null
  private createWorkerClient: (
    worker: Worker,
    onProgress: ProgressFn,
  ) => WorkerClient
  private onProgress: ProgressFn
  private postStatus: StatusFn
  private onBackendChange: (backend: TranslationBackendInfo | null) => void

  constructor(opts: {
    createWorkerClient: (
      worker: Worker,
      onProgress: ProgressFn,
    ) => WorkerClient
    onProgress: ProgressFn
    postStatus: StatusFn
    onBackendChange: (backend: TranslationBackendInfo | null) => void
  }) {
    this.createWorkerClient = opts.createWorkerClient
    this.onProgress = opts.onProgress
    this.postStatus = opts.postStatus
    this.onBackendChange = opts.onBackendChange
  }

  getBackend() {
    return this.backend
  }

  private setBackend(backend: TranslationBackendInfo | null) {
    this.backend = backend
    this.onBackendChange(backend)
  }

  needsTranslation(sourceLang: string, targetLang: string) {
    return (
      targetLang !== "none" &&
      sourceLang !== "auto" &&
      targetLang !== sourceLang
    )
  }

  async tryBuiltinTranslator(src: string, tgt: string) {
    const Translator = (self as any).Translator
    if (!Translator) return null
    const postStatus = this.postStatus
    try {
      const availability = await Translator.availability({
        sourceLanguage: src,
        targetLanguage: tgt,
      })
      if (availability === "unavailable") return null
      return await Translator.create({
        sourceLanguage: src,
        targetLanguage: tgt,
        monitor(m: any) {
          m.addEventListener("downloadprogress", (e: any) => {
            if (typeof e?.loaded === "number") {
              postStatus(
                "downloading",
                "Descargando traductor de Chrome",
                Math.min(1, e.loaded),
              )
            }
          })
        },
      })
    } catch (error) {
      console.warn("[subvid:translate] Translator API no disponible", error)
      return null
    }
  }

  /**
   * Precarga el backend para un par concreto.
   * Si el par cambia (p. ej. sourceLang auto detectó otro idioma), se recrea.
   */
  async ensure(sourceLang: string, targetLang: string) {
    if (!this.needsTranslation(sourceLang, targetLang)) {
      this.destroyBuiltin()
      this.translationWorkerOpts = null
      this.loadedPair = null
      this.setBackend(null)
      return
    }

    const pair = `${sourceLang}:${targetLang}`
    if (
      this.loadedPair === pair &&
      (this.builtinTranslator || this.translationClient)
    ) {
      return
    }

    this.destroyBuiltin()
    this.translationWorkerOpts = null

    // 1) Chrome Translator (local, rápido).
    this.builtinTranslator = await this.tryBuiltinTranslator(
      sourceLang,
      targetLang,
    )
    if (this.builtinTranslator) {
      this.loadedPair = pair
      this.setBackend(translationBackendInfo("chrome-translator"))
      return
    }

    // 2) MarianMT / 3) NLLB
    const marian = MARIAN_TRANSLATION_MODELS[pair]
    const model = marian || NLLB_MODEL
    this.translationWorkerOpts = marian
      ? {}
      : {
          src: LANGS[sourceLang]?.nllb,
          tgt: LANGS[targetLang]?.nllb,
        }

    if (
      !marian &&
      (!this.translationWorkerOpts.src || !this.translationWorkerOpts.tgt)
    ) {
      throw new Error(`Par de idiomas no soportado: ${pair}`)
    }

    if (!this.translationClient) {
      this.translationClient = this.createWorkerClient(
        new Worker(new URL("./translation.worker.ts", import.meta.url), {
          type: "module",
        }),
        this.onProgress,
      )
    }
    await this.translationClient.call(
      "ensure-translation",
      { model },
      [],
      MODEL_LOAD_TIMEOUT_MS,
    )
    this.loadedPair = pair
    this.setBackend(
      marian
        ? translationBackendInfo("marian", marian)
        : translationBackendInfo("nllb"),
    )
  }

  /**
   * Traduce un texto. Chrome Translator: solo el texto actual.
   * Marian/NLLB: pueden recibir contexto prependido; se extrae la última oración.
   */
  async translate(input: TranslateInput): Promise<string | null> {
    const { text, previousContext, sourceLang, targetLang } = input
    if (!text.trim()) return null
    await this.ensure(sourceLang, targetLang)

    let raw: string | null = null

    if (this.builtinTranslator) {
      raw = String(await this.builtinTranslator.translate(text))
    } else if (this.translationClient && this.translationWorkerOpts) {
      const contextPrefix = previousContext
        .filter(Boolean)
        .slice(-3)
        .join(" ")
      const payloadText = contextPrefix ? `${contextPrefix} ${text}` : text
      const result = await this.translationClient.call("translate", {
        texts: [payloadText],
        ...this.translationWorkerOpts,
      })
      const first = Array.isArray(result) ? result[0] : result
      const full = String(first?.translation_text ?? "")
      raw = contextPrefix ? lastSentence(full) || full : full
    }

    if (raw == null || !String(raw).trim()) return null
    return glossaryManager.polish(String(raw), text, targetLang)
  }

  private destroyBuiltin() {
    if (this.builtinTranslator?.destroy) {
      try {
        this.builtinTranslator.destroy()
      } catch {
        /* ya destruido */
      }
    }
    this.builtinTranslator = null
  }

  dispose() {
    this.destroyBuiltin()
    if (this.translationClient) {
      this.translationClient.terminate()
      this.translationClient = null
    }
    this.translationWorkerOpts = null
    this.loadedPair = null
    this.setBackend(null)
  }
}
