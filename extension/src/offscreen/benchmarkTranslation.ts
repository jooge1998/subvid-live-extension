/**
 * Compara el mismo texto en varios TranslationProvider.
 * No toca el pipeline en vivo, el contexto de conversación ni las colas.
 */

import type {
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from "./translationContract.ts"

export type BenchmarkRow = {
  provider: string
  latencyMs: number
  output: string
  ok: boolean
  error?: string
  inputLength: number
  outputLength: number
  sourceLanguage: string
  targetLanguage: string
}

export async function benchmarkTranslation(
  request: TranslationRequest,
  providers: TranslationProvider[],
): Promise<BenchmarkRow[]> {
  const rows: BenchmarkRow[] = []
  for (const provider of providers) {
    const started = performance.now()
    try {
      const result: TranslationResult = await provider.translate({
        ...request,
        context: request.context ? [...request.context] : undefined,
        terminology: request.terminology
          ? { ...request.terminology }
          : undefined,
      })
      rows.push({
        provider: result.provider,
        latencyMs: Math.round(result.latencyMs ?? performance.now() - started),
        output: result.translatedText,
        ok: true,
        inputLength: request.text.length,
        outputLength: result.translatedText.length,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
      })
    } catch (error) {
      rows.push({
        provider: providerName(provider),
        latencyMs: Math.round(performance.now() - started),
        output: "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        inputLength: request.text.length,
        outputLength: 0,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
      })
    }
  }
  return rows
}

export function formatBenchmarkReport(rows: BenchmarkRow[]): string {
  return rows
    .map((row) => {
      const lines = [
        `Provider: ${row.provider}`,
        `Latency: ${row.latencyMs} ms`,
        `inputLength: ${row.inputLength}`,
        `outputLength: ${row.outputLength}`,
        row.ok ? `Output: ${row.output}` : `Error: ${row.error || "failed"}`,
      ]
      return lines.join("\n")
    })
    .join("\n\n")
}

function providerName(provider: TranslationProvider): string {
  const named = provider as TranslationProvider & { id?: string }
  return named.id || "unknown"
}
