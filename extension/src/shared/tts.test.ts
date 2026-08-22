import { afterEach, describe, expect, it, vi } from "vitest"
import { speakTranslation, stopSpeaking } from "./tts.ts"

describe("TTS queue", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("encola cada traducción sin cortar el utterance anterior", () => {
    const speak = vi.fn()
    const stop = vi.fn()
    vi.stubGlobal("chrome", { tts: { speak, stop } })

    speakTranslation("Primera frase.", "es")
    speakTranslation("Segunda frase.", "es")

    expect(stop).not.toHaveBeenCalled()
    expect(speak).toHaveBeenCalledTimes(2)
    expect(speak.mock.calls[0][1]).toMatchObject({
      lang: "es-ES",
      enqueue: true,
    })
    expect(speak.mock.calls[1][1]).toMatchObject({ enqueue: true })
  })

  it("stopSpeaking sí detiene la voz y vacía la cola", () => {
    const stop = vi.fn()
    vi.stubGlobal("chrome", { tts: { speak: vi.fn(), stop } })

    stopSpeaking()

    expect(stop).toHaveBeenCalledTimes(1)
  })
})
