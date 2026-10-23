/**
 * Benchmark de desarrollo contra llama-server.
 * No arranca la extensión ni cambia el motor por defecto.
 *
 *   npm run benchmark:translation
 *   npm run benchmark:translation -- --id en-es-captain
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { benchmarkTranslation, formatBenchmarkReport } from "../src/offscreen/benchmarkTranslation.ts"
import { HyMt2TranslationProvider } from "../src/offscreen/hyMt2TranslationProvider.ts"
import type { TranslationProvider, TranslationRequest } from "../src/offscreen/translationContract.ts"

type Sample = TranslationRequest & { id: string }

const dataset = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/translation/subtitles.json"), "utf8"),
) as Sample[]

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const onlyId = arg("--id")
const limit = Number(arg("--limit") || 0)
let samples = onlyId ? dataset.filter((item) => item.id === onlyId) : dataset
if (limit > 0) samples = samples.slice(0, limit)

if (!samples.length) {
  console.error("No hay frases para el filtro indicado.")
  process.exit(1)
}

const hymt2 = new HyMt2TranslationProvider({
  baseUrl: process.env.HYMT2_BASE_URL,
  model: process.env.HYMT2_MODEL,
  timeoutMs: process.env.HYMT2_TIMEOUT_MS
    ? Number(process.env.HYMT2_TIMEOUT_MS)
    : undefined,
})

const providers: TranslationProvider[] = [hymt2]

const health = await hymt2.checkHealth()
console.log(health.detail)
if (!health.available) {
  console.error(
    "Arranca llama-server antes del benchmark. TranslateGemma no se ejecuta aquí: sigue en el navegador y se compara con la misma función benchmarkTranslation.",
  )
  process.exit(1)
}

let failed = 0
for (const sample of samples) {
  console.log(`\n# ${sample.id} ${sample.sourceLanguage} → ${sample.targetLanguage}`)
  console.log(`Input: ${sample.text}`)
  const rows = await benchmarkTranslation(
    {
      text: sample.text,
      sourceLanguage: sample.sourceLanguage,
      targetLanguage: sample.targetLanguage,
      context: sample.context,
      terminology: sample.terminology,
    },
    providers,
  )
  console.log(formatBenchmarkReport(rows))
  if (rows.some((row) => !row.ok)) failed += 1
}

if (failed) process.exit(1)
