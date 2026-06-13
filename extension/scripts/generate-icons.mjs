import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const svg = readFileSync(resolve(root, "icons/icon.svg"))

for (const size of [16, 32, 48, 128]) {
  await sharp(svg)
    .resize(size, size)
    .png()
    .toFile(resolve(root, `icons/icon${size}.png`))
  console.info(`[icons] icon${size}.png`)
}
