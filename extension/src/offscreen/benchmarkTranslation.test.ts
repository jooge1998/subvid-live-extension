import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  benchmarkTranslation,
  formatBenchmarkReport,
} from "./benchmarkTranslation.ts"
import { pipelineMetrics } from "./pipelineMetrics.ts"
import type { TranslationProvider } from "./translationContract.ts"

const dataset = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "tests/translation/subtitles.json"),
    "utf8",
  ),
) as Array<{
  id: string
  sourceLanguage: string
  targetLanguage: string
  text: string
}>

function fakeProvider(
  id: string,
  output: string,
  latencyMs: number,
): TranslationProvider & { id: string; seen: string[] } {
  const seen: string[] = []
  return {
    id,
    seen,
    async translate(request) {
      seen.push(request.text)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, latencyMs))
      return {
        translatedText: output,
        provider: id,
        latencyMs,
        metadata: {
          sourceLanguage: request.sourceLanguage,
          targetLanguage: request.targetLanguage,
        },
      }
    },
  }
}

describe("benchmarkTranslation", () => {
  it("manda el mismo texto a TranslateGemma y Hy-MT2 sin tocar el pipeline", async () => {
    const before = structuredClone(pipelineMetrics.snapshot())
    const gemma = fakeProvider("translategemma", "Hola", 5)
    const hymt2 = fakeProvider("hymt2", "Hola desde Hy-MT2", 5)
    const request = {
      text: "He said we should leave immediately.",
      sourceLanguage: "en",
      targetLanguage: "es",
      context: ["The captain entered the bridge."],
    }
    const rows = await benchmarkTranslation(request, [gemma, hymt2])
    expect(gemma.seen).toEqual([request.text])
    expect(hymt2.seen).toEqual([request.text])
    expect(rows.map((row) => row.provider)).toEqual([
      "translategemma",
      "hymt2",
    ])
    expect(rows[0].output).toBe("Hola")
    expect(rows[1].output).toContain("Hy-MT2")
    expect(pipelineMetrics.snapshot()).toEqual(before)

    const report = formatBenchmarkReport(rows)
    expect(report).toContain("Provider: translategemma")
    expect(report).toContain("Provider: hymt2")
    expect(report).toContain("Latency:")
    expect(report).toContain("inputLength:")
    expect(report).toContain("outputLength:")
  })

  it("el dataset cubre en→es, en→ja y ja→es", () => {
    expect(dataset.length).toBeGreaterThanOrEqual(20)
    expect(dataset.length).toBeLessThanOrEqual(30)
    const pairs = new Set(
      dataset.map((item) => `${item.sourceLanguage}:${item.targetLanguage}`),
    )
    expect(pairs).toEqual(new Set(["en:es", "en:ja", "ja:es"]))
    expect(dataset.every((item) => item.text.trim().length > 0)).toBe(true)
  })
})
