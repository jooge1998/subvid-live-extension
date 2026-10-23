import { afterEach, describe, expect, it, vi } from "vitest"
import { HyMt2TranslationEngine } from "./hyMt2TranslationEngine.ts"
import {
  extractChatCompletionText,
  HyMt2TranslationError,
  HyMt2TranslationProvider,
  resetHyMt2NoticeState,
} from "./hyMt2TranslationProvider.ts"

const settings = {
  baseUrl: "http://127.0.0.1:9099",
  model: "Hy-MT2-1.8B-Q4_K_M.gguf",
  timeoutMs: 50,
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  resetHyMt2NoticeState()
  vi.restoreAllMocks()
})

describe("HyMt2TranslationProvider", () => {
  it("envía idioma, contexto y el modelo al chat completions", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "Dijo que deberíamos irnos." } }],
      }),
    )
    const provider = new HyMt2TranslationProvider(settings, fetchImpl)
    const result = await provider.translate({
      text: "He said we should leave.",
      sourceLanguage: "en",
      targetLanguage: "es",
      context: ["The captain entered the bridge."],
    })

    expect(result.provider).toBe("hymt2")
    expect(result.translatedText).toBe("Dijo que deberíamos irnos.")
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.metadata).toMatchObject({
      sourceLanguage: "en",
      targetLanguage: "es",
      inputLength: "He said we should leave.".length,
      outputLength: "Dijo que deberíamos irnos.".length,
    })

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [url, init] = call
    expect(url).toBe("http://127.0.0.1:9099/v1/chat/completions")
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe("Hy-MT2-1.8B-Q4_K_M.gguf")
    expect(body.messages).toEqual([
      expect.objectContaining({ role: "user" }),
    ])
    expect(body.messages[0].content).toContain("into Spanish")
    expect(body.messages[0].content).toContain("The captain entered the bridge.")
    expect(body.messages[0].content).toContain("He said we should leave.")
    expect(body.temperature).toBe(0.7)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("aborta cuando se vence el timeout", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(1000)
      const controller = new AbortController()
      queueMicrotask(() => controller.abort())
      return controller.signal
    })
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () => {
            const error = new Error("The operation was aborted")
            error.name = "TimeoutError"
            reject(error)
          }
          if (init?.signal?.aborted) fail()
          else init?.signal?.addEventListener("abort", fail, { once: true })
        }),
    )
    const provider = new HyMt2TranslationProvider(
      { ...settings, timeoutMs: 20 },
      fetchImpl,
    )
    await expect(
      provider.translate({
        text: "Hello",
        sourceLanguage: "en",
        targetLanguage: "es",
      }),
    ).rejects.toMatchObject({ kind: "timeout" })
  })

  it("clasifica un HTTP error", async () => {
    const provider = new HyMt2TranslationProvider(settings, async () =>
      jsonResponse({ error: "busy" }, 503),
    )
    await expect(
      provider.translate({
        text: "Hello",
        sourceLanguage: "en",
        targetLanguage: "ja",
      }),
    ).rejects.toMatchObject({
      kind: "http",
      message: expect.stringContaining("Hy-MT2 unavailable at http://127.0.0.1:9099"),
    })
  })

  it("no repite el aviso de conexión en ráfaga", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "info").mockImplementation(() => undefined)
    const provider = new HyMt2TranslationProvider(settings, async () => {
      throw new TypeError("fetch failed")
    })
    const request = {
      text: "Hello",
      sourceLanguage: "en",
      targetLanguage: "es",
    }
    await expect(provider.translate(request)).rejects.toBeInstanceOf(
      HyMt2TranslationError,
    )
    await expect(provider.translate(request)).rejects.toMatchObject({
      kind: "connection",
    })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("extrae texto y rechaza vacío o inválido", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: "  Hola  " } }],
      }),
    ).toBe("Hola")
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: [{ type: "text", text: "こんにちは" }] } }],
      }),
    ).toBe("こんにちは")
    expect(() => extractChatCompletionText({ choices: [{ message: { content: "  " } }] })).toThrow(
      expect.objectContaining({ kind: "empty" }),
    )
    expect(() => extractChatCompletionText({ nope: true })).toThrow(
      expect.objectContaining({ kind: "invalid" }),
    )
  })

  it("marca el servidor como available o unavailable", async () => {
    const up = new HyMt2TranslationProvider(settings, async () =>
      jsonResponse({ data: [{ id: "Hy-MT2-1.8B-Q4_K_M.gguf" }] }),
    )
    await expect(up.checkHealth()).resolves.toMatchObject({
      available: true,
      detail: "Hy-MT2 available",
    })

    const down = new HyMt2TranslationProvider(settings, async () => {
      throw new TypeError("connect ECONNREFUSED")
    })
    const health = await down.checkHealth()
    expect(health.available).toBe(false)
    expect(health.detail).toContain("Hy-MT2 unavailable at http://127.0.0.1:9099")
  })
})

describe("HyMt2TranslationEngine", () => {
  it("no rompe el pipeline si llama-server no responde", async () => {
    const statuses: string[] = []
    const engine = new HyMt2TranslationEngine({
      settings,
      postStatus: (_phase, detail) => {
        if (detail) statuses.push(detail)
      },
      onBackendChange: () => undefined,
      fetchImpl: async () => {
        throw new TypeError("fetch failed")
      },
    })
    const result = await engine.translate({
      text: "Hello",
      previousContext: [],
      sourceLang: "en",
      targetLang: "es",
    })
    expect(result.text).toBeNull()
    expect(result.backend?.id).toBe("hymt2")
    expect(result.outputLength).toBe(0)
    expect(statuses[0]).toContain("Hy-MT2 unavailable")
  })
})
