import { describe, expect, it } from "vitest"
import { buildHyMt2UserPrompt, HYMT2_SAMPLING } from "./hymt2Prompt.ts"

describe("buildHyMt2UserPrompt", () => {
  it("usa la plantilla oficial sin system prompt ni contexto", () => {
    const prompt = buildHyMt2UserPrompt({
      text: "Hello",
      targetLanguage: "es",
    })
    expect(prompt).toBe(
      "Translate the following text into Spanish. Note that you should only output the translated result without any additional explanation:\nHello",
    )
    expect(prompt).not.toMatch(/system/i)
    expect(HYMT2_SAMPLING.temperature).toBe(0.7)
    expect(HYMT2_SAMPLING.top_p).toBe(0.6)
    expect(HYMT2_SAMPLING.top_k).toBe(20)
    expect(HYMT2_SAMPLING.repeat_penalty).toBe(1.05)
  })

  it("pide solo la frase nueva y marca el contexto como fondo", () => {
    const prompt = buildHyMt2UserPrompt({
      text: "He said we should leave immediately.",
      targetLanguage: "es",
      context: [
        "The captain entered the bridge.",
        "We need to prepare the ship.",
      ],
      terminology: {
        captain: "capitán",
        ship: "barco",
      },
    })
    expect(prompt).toContain("[Background Information]")
    expect(prompt).toContain("[Source Text]")
    expect(prompt).toContain("1. The captain entered the bridge.")
    expect(prompt).toContain("2. We need to prepare the ship.")
    expect(prompt).toContain("Do not translate these lines again")
    expect(prompt).toContain("captain translates to capitán")
    expect(prompt).toContain("ship translates to barco")
    expect(prompt).toContain("He said we should leave immediately.")
    expect(prompt).toContain("into Spanish")
    const sourceAt = prompt.lastIndexOf("[Source Text]")
    expect(prompt.slice(sourceAt)).not.toContain("The captain entered")
  })

  it("usa la plantilla oficial de terminología cuando no hay contexto", () => {
    const prompt = buildHyMt2UserPrompt({
      text: "The cache is full.",
      targetLanguage: "ja",
      terminology: { cache: "キャッシュ" },
    })
    expect(prompt.startsWith("Reference the following translations:")).toBe(true)
    expect(prompt).toContain("cache translates to キャッシュ")
    expect(prompt).toContain("into Japanese")
    expect(prompt).toContain("ONLY output the translated result")
  })
})
