import { describe, expect, it } from "vitest"
import {
  GEMMA_COMPLETION_CONFIDENCE,
  resolveBoundaryDecision,
} from "./boundaryDecision.ts"
import { MAX_PENDING_FRAGMENT_MS } from "./pendingFragment.ts"

describe("resolveBoundaryDecision", () => {
  it("frases incompletas típicas → PROVISIONAL sin Gemma/forzado", () => {
    for (const text of [
      "I think",
      "I think we",
      "Because",
      "And then",
      "We need",
      "We need to",
      "This is",
      "This is what",
    ]) {
      const r = resolveBoundaryDecision({
        text,
        silenceDuration: 0.15,
        isWhisperStable: true,
        heuristicComplete: false,
        heuristicReason: "grammatical_fragment",
        gemmaComplete: null,
      })
      expect(r.status, text).toBe("PROVISIONAL")
    }
  })

  it("frases cortas completas con puntuación + pausa → FINAL", () => {
    for (const text of ["Yes.", "No.", "Okay.", "Exactly.", "Wait.", "Thank you."]) {
      const r = resolveBoundaryDecision({
        text,
        silenceDuration: 0.25,
        isWhisperStable: true,
        whisperPunctuation: true,
        heuristicComplete: true,
        heuristicReason: "short_complete_utterance",
        gemmaComplete: null,
      })
      expect(r.status, text).toBe("FINAL")
      expect(["punctuation", "heuristic", "silence"]).toContain(r.reason)
    }
  })

  it("oración completa sin puntuación Whisper + Gemma.complete → FINAL", () => {
    // Caso clave: Whisper no puso punto y la heurística sigue esperando.
    const r = resolveBoundaryDecision({
      text: "Lo que quieren hacer es hacer recortes masivos",
      silenceDuration: 0.22,
      isWhisperStable: true,
      whisperPunctuation: false,
      heuristicComplete: false,
      heuristicReason: "waiting",
      gemmaComplete: true,
      gemmaConfidence: 0.9,
      gemmaReason: "complete_sentence",
      audioLikelyContinuing: false,
    })
    expect(r.status).toBe("FINAL")
    expect(r.reason).toBe("gemma_complete")
  })

  it("Gemma complete=true + audio sigue hablando → NO cortar", () => {
    const r = resolveBoundaryDecision({
      text: "I think we should",
      silenceDuration: 0.05,
      isWhisperStable: false,
      heuristicComplete: false,
      gemmaComplete: true,
      gemmaConfidence: 0.95,
      audioLikelyContinuing: true,
    })
    expect(r.status).toBe("PROVISIONAL")
    expect(r.reason).toBe("audio_continuing")
  })

  it("Gemma complete=false mantiene PROVISIONAL dentro de margen", () => {
    const r = resolveBoundaryDecision({
      text: "I think we should",
      silenceDuration: 0.3,
      isWhisperStable: true,
      heuristicComplete: false,
      heuristicReason: "grammatical_fragment",
      gemmaComplete: false,
      gemmaConfidence: 0.85,
      gemmaReason: "continuation_expected",
      pendingFragmentAgeMs: 1_000,
    })
    expect(r.status).toBe("PROVISIONAL")
    expect(r.reason).toBe("gemma_continuation")
  })

  it("Gemma complete=false + MAX_PENDING → FINAL", () => {
    const r = resolveBoundaryDecision({
      text: "I think we should",
      silenceDuration: 0.3,
      isWhisperStable: true,
      heuristicComplete: false,
      gemmaComplete: false,
      gemmaConfidence: 0.9,
      pendingFragmentAgeMs: MAX_PENDING_FRAGMENT_MS + 1,
    })
    expect(r.status).toBe("FINAL")
    expect(r.reason).toBe("max_pending_limit")
  })

  it("Gemma no disponible → heurísticas siguen funcionando", () => {
    const incomplete = resolveBoundaryDecision({
      text: "Because",
      silenceDuration: 0.2,
      isWhisperStable: true,
      heuristicComplete: false,
      heuristicReason: "continuation_word",
      gemmaComplete: null,
    })
    expect(incomplete.status).toBe("PROVISIONAL")

    const complete = resolveBoundaryDecision({
      text: "Because we need more time.",
      silenceDuration: 0.35,
      isWhisperStable: true,
      whisperPunctuation: true,
      heuristicComplete: true,
      heuristicReason: "terminal_punctuation",
      gemmaComplete: null,
    })
    expect(complete.status).toBe("FINAL")
  })

  it("I think we should do this (sin punto ASR) + Gemma → gemma_complete", () => {
    const r = resolveBoundaryDecision({
      text: "I think we should do this",
      silenceDuration: 0.25,
      isWhisperStable: true,
      whisperPunctuation: false,
      heuristicComplete: false,
      heuristicReason: "waiting",
      gemmaComplete: true,
      gemmaConfidence: GEMMA_COMPLETION_CONFIDENCE,
      audioLikelyContinuing: false,
    })
    expect(r.status).toBe("FINAL")
    expect(r.reason).toBe("gemma_complete")
  })

  it("And then we left. con puntuación → FINAL", () => {
    const r = resolveBoundaryDecision({
      text: "And then we left.",
      silenceDuration: 0.3,
      isWhisperStable: true,
      whisperPunctuation: true,
      heuristicComplete: true,
      gemmaComplete: null,
    })
    expect(r.status).toBe("FINAL")
  })

  it("confianza Gemma bajo umbral no cierra por gemma_complete", () => {
    const r = resolveBoundaryDecision({
      text: "Something that looks done",
      silenceDuration: 0.25,
      isWhisperStable: true,
      heuristicComplete: false,
      heuristicReason: "grammatical_fragment",
      gemmaComplete: true,
      gemmaConfidence: GEMMA_COMPLETION_CONFIDENCE - 0.2,
      audioLikelyContinuing: false,
    })
    expect(r.status).toBe("PROVISIONAL")
    expect(r.reason).not.toBe("gemma_complete")
  })
})
