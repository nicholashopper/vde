/**
 * Generates VDE's application icons with no image dependencies.
 *
 * The mark: five bars rising in the brand blue with one — the tallest — in the
 * critical red. That is the product in one glyph: a repository looks fine in
 * aggregate until you see which part of it is the problem.
 *
 * Everything is drawn into an RGBA buffer at 4x and box-downsampled for
 * antialiasing, then encoded as PNG by hand (zlib is in Node; CRC-32 is twenty
 * lines). .icns is assembled with macOS iconutil when available; .ico is
 * written directly, since the ICO container is just a header plus embedded PNGs.
 *
 * Run: node build/make-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SS = 4 // supersampling factor

// -- colour ------------------------------------------------------------------

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
]

const BG_TOP = hex('#1a2a44')
const BG_BOTTOM = hex('#0a0f18')
const BAR = hex('#3987e5')
const BAR_DIM = hex('#256abf')
const ALERT = hex('#d03b3b')

// -- drawing -----------------------------------------------------------------

function makeCanvas(size) {
  return { size, data: new Uint8ClampedArray(size * size * 4) }
}

function px(c, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return
  const i = (y * c.size + x) * 4
  const src = a / 255
  const dstA = c.data[i + 3] / 255
  const outA = src + dstA * (1 - src)
  if (outA === 0) return
  c.data[i] = (r * src + c.data[i] * dstA * (1 - src)) / outA
  c.data[i + 1] = (g * src + c.data[i + 1] * dstA * (1 - src)) / outA
  c.data[i + 2] = (b * src + c.data[i + 2] * dstA * (1 - src)) / outA
  c.data[i + 3] = outA * 255
}

/** Signed distance to a rounded rectangle; negative inside. */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r
}

function fillRoundRect(c, cx, cy, hw, hh, r, colorAt) {
  const x0 = Math.max(0, Math.floor(cx - hw - 1))
  const x1 = Math.min(c.size - 1, Math.ceil(cx + hw + 1))
  const y0 = Math.max(0, Math.floor(cy - hh - 1))
  const y1 = Math.min(c.size - 1, Math.ceil(cy + hh + 1))
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (sdRoundRect(x + 0.5, y + 0.5, cx, cy, hw, hh, r) <= 0) {
        const { color, alpha } = colorAt(x, y)
        px(c, x, y, color, alpha)
      }
    }
  }
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

function draw(size) {
  const S = size * SS
  const c = makeCanvas(S)

  // The plate. macOS expects transparent margin around the artwork.
  const inset = S * 0.09
  const hw = S / 2 - inset
  const radius = S * 0.2
  fillRoundRect(c, S / 2, S / 2, hw, hw, radius, (_x, y) => ({
    color: lerp(BG_TOP, BG_BOTTOM, y / S),
    alpha: 255
  }))

  // Five bars. Heights chosen so the fourth is tallest and reads as the outlier.
  const heights = [0.30, 0.46, 0.38, 0.72, 0.55]
  const alert = 3
  const plotW = hw * 2 * 0.66
  const gap = plotW * 0.075
  const barW = (plotW - gap * (heights.length - 1)) / heights.length
  const baseY = S / 2 + hw * 0.60
  const left = S / 2 - plotW / 2
  const barR = barW * 0.28

  heights.forEach((h, i) => {
    const barH = hw * 2 * 0.62 * h
    const cx = left + i * (barW + gap) + barW / 2
    const cy = baseY - barH / 2
    const isAlert = i === alert
    const top = isAlert ? ALERT : BAR
    const bottom = isAlert ? ALERT : BAR_DIM
    fillRoundRect(c, cx, cy, barW / 2, barH / 2, Math.min(barR, barH / 2), (_x, y) => ({
      color: lerp(top, bottom, Math.min(1, (y - (cy - barH / 2)) / barH)),
      alpha: 255
    }))
  })

  // Baseline hairline, the instrument cue.
  fillRoundRect(c, S / 2, baseY + S * 0.012, plotW / 2, S * 0.006, S * 0.006, () => ({
    color: [255, 255, 255],
    alpha: 46
  }))

  return downsample(c, size)
}

function downsample(c, size) {
  const out = makeCanvas(size)
  const n = SS * SS
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * c.size + (x * SS + dx)) * 4
          const sa = c.data[i + 3] / 255
          r += c.data[i] * sa
          g += c.data[i + 1] * sa
          b += c.data[i + 2] * sa
          a += c.data[i + 3]
        }
      }
      const o = (y * size + x) * 4
      const aSum = a / 255
      out.data[o] = aSum > 0 ? r / aSum : 0
      out.data[o + 1] = aSum > 0 ? g / aSum : 0
      out.data[o + 2] = aSum > 0 ? b / aSum : 0
      out.data[o + 3] = a / n
    }
  }
  return out
}

// -- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(canvas) {
  const { size, data } = canvas
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// -- ICO ---------------------------------------------------------------------

function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16
    dir[o] = size >= 256 ? 0 : size
    dir[o + 1] = size >= 256 ? 0 : size
    dir[o + 2] = 0 // palette
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32BE(0, o + 8)
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)])
}

// -- main --------------------------------------------------------------------

const png = (size) => encodePng(draw(size))

writeFileSync(join(HERE, 'icon.png'), png(1024))
console.log('wrote build/icon.png (1024)')

writeFileSync(
  join(HERE, 'icon.ico'),
  encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, buf: png(size) })))
)
console.log('wrote build/icon.ico')

if (process.platform === 'darwin') {
  const set = join(HERE, 'icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  const entries = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png']
  ]
  const cache = new Map()
  for (const [size, name] of entries) {
    if (!cache.has(size)) cache.set(size, png(size))
    writeFileSync(join(set, name), cache.get(size))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(HERE, 'icon.icns')])
  rmSync(set, { recursive: true, force: true })
  console.log('wrote build/icon.icns')
} else if (!existsSync(join(HERE, 'icon.icns'))) {
  console.log('skipped icon.icns (needs macOS iconutil)')
}
