import { describe, expect, it } from "vitest"
import { analyzeBoundary } from "./sentenceBoundaryDetector.ts"

describe("analyzeBoundary", () => {
  it("finaliza enunciados cortos completos tras pausa breve", () => {
    for (const text of ["Yes.", "No.", "Okay.", "Exactly.", "Wait."]) {
      const r = analyzeBoundary({
        text,
        silenceDuration: 0.4,
        audioDuration: 0.5,
        isWhisperStable: true,
        asrConfidence: 0.9,
      })
      expect(r.isLikelyComplete, text).toBe(true)
      expect(r.reason).toBe("short_complete_utterance")
    }
  })

  it("marca fragmentos gramaticales como provisional", () => {
    for (const text of [
      "I think",
      "I think we",
      "I think we should",
      "Because",
      "Because we need",
      "And then",
      "This is",
      "This is exactly",
      "This is exactly what",
    ]) {
      const r = analyzeBoundary({
        text,
        silenceDuration: 0.25,
        audioDuration: 1.2,
        isWhisperStable: true,
        asrConfidence: 0.8,
      })
      expect(r.isLikelyComplete, text).toBe(false)
      expect(["continuation_word", "grammatical_fragment"]).toContain(r.reason)
    }
  })

  it("finaliza frase completa con puntuación + silencio", () => {
    const r = analyzeBoundary({
      text: "This is exactly what we need.",
      silenceDuration: 0.7,
      audioDuration: 2.5,
      isWhisperStable: true,
      asrConfidence: 0.9,
    })
    expect(r.isLikelyComplete).toBe(true)
    expect(r.reason).toBe("terminal_punctuation")
  })

  it("Hello how are you? con silencio → final", () => {
    const r = analyzeBoundary({
      text: "Hello, how are you?",
      silenceDuration: 0.65,
      audioDuration: 1.8,
      isWhisperStable: true,
      asrConfidence: 0.85,
    })
    expect(r.isLikelyComplete).toBe(true)
  })

  it("Yeah. es short complete; Yeah I know. con silencio es final", () => {
    expect(
      analyzeBoundary({
        text: "Yeah.",
        silenceDuration: 0.4,
        audioDuration: 0.4,
        isWhisperStable: true,
      }).isLikelyComplete,
    ).toBe(true)

    const longer = analyzeBoundary({
      text: "Yeah, I know.",
      silenceDuration: 0.7,
      audioDuration: 1.0,
      isWhisperStable: true,
      asrConfidence: 0.9,
    })
    expect(longer.isLikelyComplete).toBe(true)
  })

  it("I don't know. puede finalizar; continuación incompleta no", () => {
    expect(
      analyzeBoundary({
        text: "I don't know.",
        silenceDuration: 0.5,
        audioDuration: 0.8,
        isWhisperStable: true,
      }).isLikelyComplete,
    ).toBe(true)

    expect(
      analyzeBoundary({
        text: "I don't know what they're doing",
        silenceDuration: 0.2,
        audioDuration: 1.5,
        isWhisperStable: false,
        asrConfidence: 0.4,
      }).reason,
    ).toBe("whisper_unstable")
  })

  it("puntuación sin silencio suficiente no fuerza FINAL", () => {
    const r = analyzeBoundary({
      text: "We should continue.",
      silenceDuration: 0.1,
      audioDuration: 1.0,
      isWhisperStable: true,
      asrConfidence: 0.8,
    })
    expect(r.isLikelyComplete).toBe(false)
  })
})
