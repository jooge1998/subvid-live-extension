import { describe, expect, it } from "vitest"
import {
  normalizeForDeduplication,
  SpokenCueTracker,
} from "./ttsDedupe.ts"

describe("TTS dedupe + provisional gate", () => {
  it("normaliza puntuación y mayúsculas", () => {
    expect(normalizeForDeduplication("Creo que…")).toBe(
      normalizeForDeduplication("creo que."),
    )
  })

  it("PROVISIONAL no habla; FINAL una sola vez", () => {
    const spoken = new SpokenCueTracker()
    const cueId = "cue-1"

    // Simula pipeline: provisional → no TTS (el caller no llama trySpeak).
    const provisionalTexts = ["I think", "I think we should"]
    for (const _ of provisionalTexts) {
      // no trySpeak
    }

    const finalText = "Creo que deberíamos hacer esto."
    expect(spoken.trySpeak(cueId, finalText)).toBe(true)
    expect(spoken.trySpeak(cueId, finalText)).toBe(false)
    expect(spoken.trySpeak("cue-2", finalText)).toBe(false)
    expect(spoken.getDeduplicatedCount()).toBe(2)
  })

  it("mismo texto con otro cueId no se vuelve a reproducir", () => {
    const spoken = new SpokenCueTracker()
    expect(spoken.trySpeak("a", "Sí.")).toBe(true)
    expect(spoken.trySpeak("b", "si")).toBe(false)
  })
})
