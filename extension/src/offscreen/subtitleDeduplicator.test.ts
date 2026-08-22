import { describe, expect, it } from "vitest"
import {
  dedupeSubtitle,
  SubtitleDeduplicator,
} from "./subtitleDeduplicator.ts"

describe("subtitle deduplication", () => {
  it("reutiliza el cue cuando Whisper extiende la frase anterior", () => {
    const result = dedupeSubtitle({
      previousText: "Let me give you a background story just so everyone",
      nextText:
        "Let me give you a background story just so everyone had a very close friend to call Jake.",
    })

    expect(result.reuse).toBe(true)
    expect(result.kind).toBe("continuation")
    expect(result.deltaText).toContain("had a very close friend")
  })

  it("conserva el mismo cueId para la extensión", () => {
    const deduper = new SubtitleDeduplicator()
    const first = deduper.resolve(
      "Jake and I have been friends",
      null,
      () => "cue-1",
    )
    const second = deduper.resolve(
      "Jake and I have been friends since I can remember.",
      first.cueId,
      () => "cue-2",
    )

    expect(second.cueId).toBe("cue-1")
    expect(second.reuse).toBe(true)
  })
})
