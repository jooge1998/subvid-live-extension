import { describe, expect, it } from "vitest"
import {
  buildGemmaStructuredUserPrompt,
  extractJsonObject,
  parseGemmaStructuredOutput,
} from "./gemmaStructuredOutput.ts"

describe("parseGemmaStructuredOutput", () => {
  it("parsea JSON completo", () => {
    const r = parseGemmaStructuredOutput(
      JSON.stringify({
        translation: "Creo que deberíamos hacer esto.",
        complete: true,
        confidence: 0.92,
        reason: "complete_sentence",
      }),
      "I think we should do this.",
    )
    expect(r.translation).toContain("Creo")
    expect(r.complete).toBe(true)
    expect(r.confidence).toBeCloseTo(0.92)
    expect(r.reason).toBe("complete_sentence")
  })

  it("I think → incomplete", () => {
    const r = parseGemmaStructuredOutput(
      `{"translation":"Creo","complete":false,"confidence":0.88,"reason":"continuation_expected"}`,
      "I think",
    )
    expect(r.complete).toBe(false)
    expect(r.reason).toBe("continuation_expected")
  })

  it("texto plano sin JSON → complete=null (no inventar)", () => {
    const r = parseGemmaStructuredOutput("Hola mundo", "Hello world")
    expect(r.translation).toBe("Hola mundo")
    expect(r.complete).toBeNull()
    expect(r.reason).toBe("unknown")
  })

  it("tolera fence markdown", () => {
    const r = parseGemmaStructuredOutput(
      '```json\n{"translation":"Sí.","complete":true,"confidence":0.95,"reason":"complete_short_utterance"}\n```',
      "Yes.",
    )
    expect(r.complete).toBe(true)
    expect(r.reason).toBe("complete_short_utterance")
  })

  it("extractJsonObject ignora prefijo", () => {
    const obj = extractJsonObject(
      'Here you go: {"translation":"X","complete":false,"confidence":0.5,"reason":"ambiguous"}',
    ) as any
    expect(obj.translation).toBe("X")
    expect(obj.complete).toBe(false)
  })
})

describe("buildGemmaStructuredUserPrompt", () => {
  it("incluye SOURCE y prohíbe inventar", () => {
    const p = buildGemmaStructuredUserPrompt({
      text: "I think",
      sourceLang: "en",
      targetLang: "es",
      previousContext: ["They left."],
    })
    expect(p).toContain("SOURCE:")
    expect(p).toContain("I think")
    expect(p).toMatch(/Do NOT invent/i)
    expect(p).toContain("They left.")
  })
})
