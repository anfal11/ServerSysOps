// Renders build/logo.svg into build/icon.png (512), build/icon.ico (16–256) and site/logo.png.
// Run with Electron so the SVG is rasterised by Chromium:
//   node node_modules/electron/cli.js scripts/make-icons.mjs
import { app, BrowserWindow, nativeImage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'build', 'logo.svg'), 'utf8')
const SIZE = 1024

/** Classic 32-bit DIB icon entry (BITMAPINFOHEADER + bottom-up BGRA rows + empty AND mask). */
function dib(img, size) {
  const bgra = img.toBitmap() // BGRA, top-down, size*size*4
  const stride = size * 4
  const maskStride = Math.ceil(size / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND height
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(stride * size + maskStride * size, 20)
  const pixels = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) bgra.copy(pixels, (size - 1 - y) * stride, y * stride, y * stride + stride)
  return Buffer.concat([header, pixels, Buffer.alloc(maskStride * size)])
}

function ico(pngs) {
  // ICONDIR + ICONDIRENTRY[] + image blobs: DIB for the small sizes Windows uses in the taskbar and
  // Explorer (most compatible), PNG for 128/256 (smaller file).
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE, transparent: true, frame: false, webPreferences: { offscreen: true } })
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('width="256" height="256"', `width="${SIZE}" height="${SIZE}"`)}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  const at = (s) => full.resize({ width: s, height: s, quality: 'best' })
  writeFileSync(join(root, 'build', 'icon.png'), at(512).toPNG())
  writeFileSync(join(root, 'build', 'icon@1024.png'), full.toPNG())
  mkdirSync(join(root, 'site'), { recursive: true })
  writeFileSync(join(root, 'site', 'logo.png'), at(256).toPNG())
  writeFileSync(join(root, 'site', 'apple-touch-icon.png'), at(180).toPNG())
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  writeFileSync(join(root, 'build', 'icon.ico'), ico(sizes.map((s) => ({ size: s, data: s >= 128 ? at(s).toPNG() : dib(at(s), s) }))))
  console.log('icons written:', sizes.join(','), '+ icon.png 512, site/logo.png')
  app.quit()
})
