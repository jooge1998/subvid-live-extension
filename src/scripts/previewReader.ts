// While subtitles are generated, the config preview is "read": the video frame
// starts dithered and a scan line that follows the real progress clears it.
// It only observes the progress UI, so the generation code stays untouched.
import { ditherInto } from "@/scripts/dither.ts"

// CSS pixels per dithered cell.
const CELL = 2
// The dithered frame shimmers at a low rate, like a scanner.
const FRAME_MS = 1000 / 12

type PreviewReaderOptions = {
  stage: HTMLElement
  preview: HTMLElement
  video: HTMLVideoElement
  progress: HTMLElement
  track: HTMLElement
  fill: HTMLElement
}

export function createPreviewReader({
  stage,
  preview,
  video,
  progress,
  track,
  fill,
}: PreviewReaderOptions) {
  const canvas = document.createElement("canvas")
  canvas.className = "config-reader"
  canvas.setAttribute("aria-hidden", "true")
  preview.append(canvas)

  const ctx = canvas.getContext("2d")
  const sampler = document.createElement("canvas")
  const samplerCtx = sampler.getContext("2d", { willReadFrequently: true })
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")
  let output: ImageData | null = null
  let pixels: Uint32Array | null = null
  let reading = false
  let raf = 0
  let last = 0

  function resize() {
    const width = Math.max(64, Math.round(preview.clientWidth / CELL))
    const height = Math.max(36, Math.round(preview.clientHeight / CELL))
    if (!ctx || (width === canvas.width && height === canvas.height && output)) return
    canvas.width = sampler.width = width
    canvas.height = sampler.height = height
    output = ctx.createImageData(width, height)
    pixels = new Uint32Array(output.data.buffer)
  }

  function render(grain = 0) {
    if (!ctx || !samplerCtx || !output || !pixels) return
    if (video.readyState < 2 || !video.videoWidth) return
    const { width, height } = canvas
    // Same box as the video's `object-fit: contain`.
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
    const drawWidth = video.videoWidth * scale
    const drawHeight = video.videoHeight * scale
    samplerCtx.clearRect(0, 0, width, height)
    samplerCtx.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
    ditherInto(samplerCtx.getImageData(0, 0, width, height).data, pixels, width, height, { grain })
    ctx.putImageData(output, 0, 0)
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick)
    if (now - last < FRAME_MS) return
    last = now
    render(0.06)
  }

  function sync() {
    const nextReading = !progress.hidden && stage.offsetParent !== null
    const percent = nextReading ? Number(track.getAttribute("aria-valuenow") ?? 0) : 0
    stage.style.setProperty("--read", String(Math.min(100, Math.max(0, percent)) / 100))
    preview.classList.toggle("is-scanning", fill.classList.contains("is-indeterminate"))
    if (nextReading === reading) return

    reading = nextReading
    preview.classList.toggle("is-reading", reading)
    if (reading) {
      resize()
      render()
      if (!reduceMotion.matches && !raf) {
        last = performance.now()
        raf = requestAnimationFrame(tick)
      }
    } else if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }

  new MutationObserver(sync).observe(progress, { attributes: true, attributeFilter: ["hidden"] })
  new MutationObserver(sync).observe(track, { attributes: true, attributeFilter: ["aria-valuenow"] })
  new MutationObserver(sync).observe(fill, { attributes: true, attributeFilter: ["class"] })
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ["hidden"] })
  new ResizeObserver(() => {
    resize()
    if (reading) render()
  }).observe(preview)
  video.addEventListener("loadeddata", () => reading && render())
  sync()
}
