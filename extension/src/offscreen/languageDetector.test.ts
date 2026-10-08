import { afterEach, describe, expect, it, vi } from "vitest"
import { LanguageDetector } from "./languageDetector.ts"

describe("LanguageDetector auto", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("acepta la primera detección útil aunque Chrome dé menos de 60%", async () => {
    const detectLanguage = vi.fn().mockResolvedValue({
      languages: [
        { language: "en", percentage: 45 },
        { language: "de", percentage: 20 },
      ],
      isReliable: false,
    })
    vi.stubGlobal("chrome", { i18n: { detectLanguage } })

    const detector = new LanguageDetector()
    await expect(detector.resolve("This is a short sentence")).resolves.toBe(
      "en",
    )
  })

  it("acumula fragmentos cortos para mejorar la detección", async () => {
    const detectLanguage = vi
      .fn()
      .mockResolvedValueOnce({
        languages: [
          { language: "fr", percentage: 18 },
          { language: "es", percentage: 16 },
        ],
      })
      .mockResolvedValueOnce({
        languages: [
          { language: "fr", percentage: 48 },
          { language: "es", percentage: 19 },
        ],
      })
    vi.stubGlobal("chrome", { i18n: { detectLanguage } })

    const detector = new LanguageDetector()
    await expect(detector.resolve("Bonjour")).resolves.toBeNull()
    await expect(detector.resolve("comment allez vous")).resolves.toBe("fr")
    expect(detectLanguage.mock.calls[1][0]).toContain(
      "Bonjour comment allez vous",
    )
  })

  it("detecta escrituras inequívocas sin depender de Chrome", async () => {
    const detectLanguage = vi.fn()
    vi.stubGlobal("chrome", { i18n: { detectLanguage } })

    const detector = new LanguageDetector()
    await expect(detector.resolve("これは日本語です")).resolves.toBe("ja")
    expect(detectLanguage).not.toHaveBeenCalled()
  })

  it("normaliza códigos regionales", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn().mockResolvedValue({
          languages: [{ language: "pt-BR", percentage: 95 }],
        }),
      },
    })

    const detector = new LanguageDetector()
    await expect(detector.resolve("Muito obrigado")).resolves.toBe("pt")
  })
})
