import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { crx } from "@crxjs/vite-plugin"
import { defineConfig, type Plugin } from "vite"
import manifest from "./manifest.config.ts"

// onnxruntime-web (dentro de transformers.js) carga sus binarios .wasm/.mjs en
// tiempo de ejecución. Los copiamos al paquete para no depender de un CDN y
// los workers apuntan a chrome-extension://<id>/wasm/.
function copyOrtRuntime(): Plugin {
  return {
    name: "copy-ort-runtime",
    apply: "build",
    closeBundle() {
      const root = process.cwd()
      const src = resolve(root, "node_modules/onnxruntime-web/dist")
      const out = resolve(root, "dist/wasm")
      if (!existsSync(src)) {
        console.warn("[copy-ort-runtime] no se encontró", src)
        return
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
      console.info(`[copy-ort-runtime] ${copied} archivos copiados a dist/wasm`)
    },
  }
}

// ffmpeg.wasm (mux de audio+video en el offscreen) carga su núcleo en tiempo
// de ejecución desde chrome-extension://<id>/ffmpeg/.
function copyFfmpegCore(): Plugin {
  return {
    name: "copy-ffmpeg-core",
    apply: "build",
    closeBundle() {
      const root = process.cwd()
      const src = resolve(root, "node_modules/@ffmpeg/core/dist/esm")
      const out = resolve(root, "dist/ffmpeg")
      if (!existsSync(src)) {
        console.warn("[copy-ffmpeg-core] no se encontró", src)
        return
      }
      mkdirSync(out, { recursive: true })
      for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
        copyFileSync(resolve(src, file), resolve(out, file))
      }
      console.info("[copy-ffmpeg-core] núcleo de ffmpeg copiado a dist/ffmpeg")
    },
  }
}

export default defineConfig({
  plugins: [crx({ manifest }), copyOrtRuntime(), copyFfmpegCore()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        offscreen: "src/offscreen/offscreen.html",
      },
    },
  },
  worker: {
    format: "es",
  },
})
