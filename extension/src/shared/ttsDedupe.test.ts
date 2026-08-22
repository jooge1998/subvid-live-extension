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
    expect(spoken.trySpeak(cueId, finalText, 3)).toBe(true)
    expect(spoken.trySpeak(cueId, finalText, 3)).toBe(false)
    expect(spoken.trySpeak("cue-2", finalText, 1)).toBe(false)
    expect(spoken.getDeduplicatedCount()).toBe(2)
  })

  it("solo la generation FINAL más nueva puede re-hablar el mismo cueId", () => {
    const spoken = new SpokenCueTracker()
    expect(spoken.trySpeak("cue-1", "Creo.", 1)).toBe(true)
    // Revisión mayor con texto distinto (FINAL corregido).
    expect(spoken.trySpeak("cue-1", "Creo que deberíamos hacerlo.", 3)).toBe(
      true,
    )
    // Generation antigua o igual → no.
    expect(spoken.trySpeak("cue-1", "Creo que no.", 2)).toBe(false)
  })

  it("mismo texto con otro cueId no se vuelve a reproducir", () => {
    const spoken = new SpokenCueTracker()
    expect(spoken.trySpeak("a", "Sí.")).toBe(true)
    expect(spoken.trySpeak("b", "si")).toBe(false)
  })
})
