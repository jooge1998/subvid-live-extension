// A short "interview" for the home demo. The source is a 3-frame sprite (rest,
// talking, blink) sampled at a low resolution every frame, dithered into the
// subvid palette and scaled up with `image-rendering: pixelated`.
import { ditherInto, INK } from "@/scripts/dither.ts"

// The footage is dark: lift it a little so the dithering has room to work.
const GAIN = 1.35
const LIFT = 0.02

export const SPRITE_FRAMES = 3
export const FRAME = { rest: 0, talk: 1, blink: 2 } as const

export type SceneState = {
  // Which sprite frame to show.
  frame: number
  // ≥ 1: slow push-in on the speaker.
  zoom: number
  // −0.5 → 0.5: where the zoomed crop sits inside the frame.
  panX: number
  panY: number
  // 0 → 1: the frame dissolves in block by block, like a file being read.
  reveal: number
  // Amount of per-frame noise, so playback "breathes" like real footage.
  grain: number
}

export function createDitherScene(
  canvas: HTMLCanvasElement,
  spriteUrl: string,
  onLoad: () => void,
) {
  const ctx = canvas.getContext("2d", { alpha: false })
  const sampler = document.createElement("canvas")
  const samplerCtx = sampler.getContext("2d", { willReadFrequently: true })
  let width = 0
  let height = 0
  let image: ImageData | null = null
  let pixels: Uint32Array | null = null
  let sprite: HTMLImageElement | null = null

  const source = new Image()
  source.decoding = "async"
  source.src = spriteUrl
  source
    .decode()
    .then(() => {
      sprite = source
      onLoad()
    })
    .catch(() => {})

  // Picks a resolution so each dithered cell is about `cell` CSS pixels wide.
  function resize(cssWidth: number, cell: number) {
    const nextWidth = Math.max(96, Math.round(cssWidth / cell))
    const nextHeight = Math.round((nextWidth * 9) / 16)
    if (!ctx || (nextWidth === width && nextHeight === height)) return
    width = canvas.width = sampler.width = nextWidth
    height = canvas.height = sampler.height = nextHeight
    image = ctx.createImageData(width, height)
    pixels = new Uint32Array(image.data.buffer)
  }

  function render({ frame, zoom, panX, panY, reveal, grain }: SceneState) {
    if (!ctx || !samplerCtx || !image || !pixels) return
    if (!sprite) {
      pixels.fill(INK)
      ctx.putImageData(image, 0, 0)
      return
    }

    const frameWidth = sprite.naturalWidth
    const frameHeight = sprite.naturalHeight / SPRITE_FRAMES
    const cropWidth = frameWidth / zoom
    const cropHeight = frameHeight / zoom
    samplerCtx.drawImage(
      sprite,
      (frameWidth - cropWidth) * (0.5 + panX),
      frame * frameHeight + (frameHeight - cropHeight) * (0.5 + panY),
      cropWidth,
      cropHeight,
      0,
      0,
      width,
      height,
    )
    ditherInto(samplerCtx.getImageData(0, 0, width, height).data, pixels, width, height, {
      gain: GAIN,
      lift: LIFT,
      grain,
      reveal,
    })
    ctx.putImageData(image, 0, 0)
  }

  return { resize, render }
}
