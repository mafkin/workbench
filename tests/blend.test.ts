import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePng, readBlendPreview } from '../server/thumbs.ts'

// A 4×2 preview, stored bottom-up as Blender does: the bottom row red, the top row blue.
const W = 4
const H = 2
const RED = [255, 0, 0, 255]
const BLUE = [0, 0, 255, 255]
const PIXELS = Buffer.from([...Array(W).fill(RED).flat(), ...Array(W).fill(BLUE).flat()])

interface Layout {
  header: 'classic' | 'blender5'
  ptr?: 4 | 8
  little?: boolean
  compress?: 'none' | 'gzip' | 'zstd'
  preview?: boolean
}

/** A .blend with a REND block, the TEST (preview) block, a GLOB block and ENDB, in the given layout. */
function makeBlend({ header, ptr = 8, little = true, compress = 'none', preview = true }: Layout): Buffer {
  const i32 = (n: number) => {
    const b = Buffer.alloc(4)
    little ? b.writeInt32LE(n) : b.writeInt32BE(n)
    return b
  }
  const i64 = (n: number) => {
    const b = Buffer.alloc(8)
    little ? b.writeBigInt64LE(BigInt(n)) : b.writeBigInt64BE(BigInt(n))
    return b
  }
  const block = (code: string, data: Buffer) => {
    const c = Buffer.from(code, 'latin1')
    const head =
      header === 'blender5'
        ? Buffer.concat([c, i32(0), i64(0x1234), i64(data.length), i64(1)])
        : Buffer.concat([c, i32(data.length), Buffer.alloc(ptr), i32(0), i32(1)])
    return Buffer.concat([head, data])
  }
  const top = header === 'blender5' ? Buffer.from(`BLENDER17-01${little ? 'v' : 'V'}0500`, 'latin1') : Buffer.from(`BLENDER${ptr === 8 ? '-' : '_'}${little ? 'v' : 'V'}405`, 'latin1')
  const parts = [top, block('REND', Buffer.alloc(72, 7))]
  if (preview) parts.push(block('TEST', Buffer.concat([i32(W), i32(H), PIXELS])))
  parts.push(block('GLOB', Buffer.alloc(16, 1)), block('ENDB', Buffer.alloc(0)))
  const raw = Buffer.concat(parts)
  return compress === 'gzip' ? zlib.gzipSync(raw) : compress === 'zstd' ? zlib.zstdCompressSync(raw) : raw
}

/** The rows of a PNG we wrote (8-bit RGBA, filter 0). */
function pngRows(png: Buffer): number[][] {
  expect(png.subarray(1, 4).toString()).toBe('PNG')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  let at = 8
  const idat: Buffer[] = []
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len))
    expect(png.readUInt32BE(at + 8 + len)).toBe(zlib.crc32(png.subarray(at + 4, at + 8 + len)))
    at += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  return Array.from({ length: height }, (_, y) => [...raw.subarray(y * (width * 4 + 1) + 1, y * (width * 4 + 1) + 1 + 4)])
}

let dir: string
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-blend-'))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the preview inside a .blend', () => {
  const layouts: [string, Layout][] = [
    ['classic, 64-bit, little-endian', { header: 'classic' }],
    ['classic, 32-bit, little-endian', { header: 'classic', ptr: 4 }],
    ['classic, 64-bit, big-endian', { header: 'classic', little: false }],
    ['classic, gzip', { header: 'classic', compress: 'gzip' }],
    ['classic, zstd (Blender 3.0+)', { header: 'classic', compress: 'zstd' }],
    ['Blender 5 header', { header: 'blender5' }],
    ['Blender 5 header, zstd', { header: 'blender5', compress: 'zstd' }],
  ]
  for (const [name, layout] of layouts) {
    it(`reads ${name}`, async () => {
      const file = path.join(dir, 'scene.blend')
      await fsp.writeFile(file, makeBlend(layout))
      const preview = await readBlendPreview(file)
      expect(preview).toEqual({ width: W, height: H, rgba: PIXELS })
    })
  }

  it('gives null for a file saved without a preview, and for one that is not a .blend', async () => {
    await fsp.writeFile(path.join(dir, 'none.blend'), makeBlend({ header: 'classic', preview: false }))
    expect(await readBlendPreview(path.join(dir, 'none.blend'))).toBeNull()
    await fsp.writeFile(path.join(dir, 'fake.blend'), 'not a blend file at all')
    expect(await readBlendPreview(path.join(dir, 'fake.blend'))).toBeNull()
    await fsp.writeFile(path.join(dir, 'cut.blend'), makeBlend({ header: 'classic' }).subarray(0, 120))
    expect(await readBlendPreview(path.join(dir, 'cut.blend'))).toBeNull()
  })

  it('encodes it as a PNG the right way up', () => {
    const rows = pngRows(encodePng(W, H, PIXELS, true))
    expect(rows).toEqual([BLUE, RED])
    expect(pngRows(encodePng(W, H, PIXELS))).toEqual([RED, BLUE])
  })
})
