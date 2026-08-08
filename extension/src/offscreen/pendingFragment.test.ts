import { describe, expect, it } from "vitest"
import { PendingFragmentManager } from "./pendingFragment.ts"

describe("PendingFragmentManager", () => {
  it("fusiona fragmentos hasta puntuación + silencio", () => {
    const mgr = new PendingFragmentManager()
    const a = mgr.ingest("I think", {
      silenceDuration: 0.2,
      audioDuration: 0.6,
      isWhisperStable: true,
      asrConfidence: 0.8,
      silenceClearSeconds: 0.6,
    })
    expect(a.isFinal).toBe(false)

    const b = mgr.ingest("we should", {
      silenceDuration: 0.2,
      audioDuration: 0.5,
      isWhisperStable: true,
      asrConfidence: 0.8,
      silenceClearSeconds: 0.6,
    })
    expect(b.isFinal).toBe(false)
    expect(b.text.toLowerCase()).toContain("think")
    expect(b.text.toLowerCase()).toContain("should")

    const c = mgr.ingest("do this.", {
      silenceDuration: 0.7,
      audioDuration: 0.6,
      isWhisperStable: true,
      asrConfidence: 0.9,
      silenceClearSeconds: 0.6,
    })
    expect(c.isFinal).toBe(true)
    expect(c.text.toLowerCase()).toMatch(/do this/)
  })

  it("Yes. con pausa corta cierra de inmediato", () => {
    const mgr = new PendingFragmentManager()
    const r = mgr.ingest("Yes.", {
      silenceDuration: 0.4,
      audioDuration: 0.3,
      isWhisperStable: true,
      asrConfidence: 0.95,
      silenceClearSeconds: 0.6,
    })
    expect(r.isFinal).toBe(true)
  })
})
