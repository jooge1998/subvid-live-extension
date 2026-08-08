import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { crx } from "@crxjs/vite-plugin"
import { defineConfig, type Plugin } from "vite"
import manifest from "./manifest.config.ts"

// onnxruntime-web (dentro de transformers.js) carga sus binarios .wasm/.mjs en
// tiempo de ejecución. Los copiamos al paquete para no depender de un CDN y
// los workers apuntan a chrome-extension://<id>/wasm/ (v3) o /wasm-v4/ (Gemma).
function copyOrtFrom(srcPkg: string, outDir: string, label: string) {
  const root = process.cwd()
  const src = resolve(root, srcPkg)
  const out = resolve(root, outDir)
  if (!existsSync(src)) {
    console.warn(`[copy-ort-runtime] no se encontró ${label}:`, src)
    return 0
  }
  mkdirSync(out, { recursive: true })
  let copied = 0
  for (const file of readdirSync(src)) {
    if (
      file.startsWith("ort-wasm-simd-threaded") &&
      (file.endsWith(".wasm") || file.endsWith(".mjs"))
    ) {
      copyFileSync(resolve(src, file), resolve(out, file))
      copied++
    }
  }
  console.info(`[copy-ort-runtime] ${copied} archivos → ${outDir} (${label})`)
  return copied
}

function copyOrtRuntime(): Plugin {
  return {
    name: "copy-ort-runtime",
    apply: "build",
    closeBundle() {
      copyOrtFrom(
        "node_modules/onnxruntime-web/dist",
        "dist/wasm",
        "transformers@3",
      )
      // ORT embebido en transformers-v4 (puede coexistir en node_modules anidados).
      const v4OrtCandidates = [
        "node_modules/@huggingface/transformers-v4/node_modules/onnxruntime-web/dist",
        "node_modules/onnxruntime-web/dist",
      ]
      for (const candidate of v4OrtCandidates) {
        if (existsSync(resolve(process.cwd(), candidate))) {
          copyOrtFrom(candidate, "dist/wasm-v4", "transformers@4 / Gemma")
          break
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [crx({ manifest }), copyOrtRuntime()],
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        offscreen: "src/offscreen/offscreen.html",
      },
    },
  },
  worker: {
    format: "es",
  },
  // El worklet se importa con ?url; no lo tratamos como worker de Vite.
  optimizeDeps: {
    exclude: [],
  },
})
