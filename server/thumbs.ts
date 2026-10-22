// Thumbnails for the gallery, in Workbench's own cache (~/.cache/workbench/thumbs).
// A thumbnail is keyed by the file's real path, mtime and size, so a changed
// file gets a new one. The browser makes most of them (it can decode images,
// video, audio and 3D) and uploads them; the service makes `.blend` ones from
// the preview Blender saves inside the file, and points a Godot project's
// folder at its icon. Old thumbnails are pruned past a size cap.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { StoreError } from './config-store.ts'
import { writeAtomic } from './fs-util.ts'
import { within } from './paths.ts'

/** Bump to throw every cached thumbnail away (a new look or size). */
const THUMB_VERSION = 1
const MAX_UPLOAD = 512 * 1024
const MAX_CACHE = 300 * 1024 * 1024
/** How much of a .blend is read looking for its preview. */
const BLEND_SCAN = 64 * 1024 * 1024

export type AssetKind = 'image' | 'video' | 'audio' | 'model' | 'blend'

const KINDS: Record<string, AssetKind> = {}
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg']) KINDS[e] = 'image'
for (const e of ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']) KINDS[e] = 'video'
for (const e of ['mp3', 'ogg', 'oga', 'opus', 'flac', 'wav', 'm4a', 'aac']) KINDS[e] = 'audio'
for (const e of ['gltf', 'glb', 'obj', 'fbx', 'stl']) KINDS[e] = 'model'
KINDS.blend = 'blend'

/** What kind of asset a file name is, by its extension (`x.blend1`, a Blender backup, counts as a .blend). */
export function assetKind(name: string): AssetKind | null {
  const ext = path.extname(name).slice(1).toLowerCase()
  return KINDS[ext] ?? (/^blend\d+$/.test(ext) ? 'blend' : null)
}

/** What the gallery is told when there is no thumbnail yet: what to make it from, if it can. */
export interface ThumbMissing {
  make: Exclude<AssetKind, 'blend'> | null
  /** Make it from this file instead (a Godot project's icon for its folder), `~/…`. */
  source?: string
}

const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const isWebp = (b: Buffer) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'

export class Thumbs {
  readonly dir: string
  #max: number
  #writes = 0

  constructor(dir: string, opts: { maxBytes?: number } = {}) {
    this.dir = dir
    this.#max = opts.maxBytes ?? MAX_CACHE
  }

  /** The cache name of a file as it is now. */
  key(real: string, st: fs.Stats): string {
    return createHash('sha1').update(`${THUMB_VERSION}\0${real}\0${Math.floor(st.mtimeMs)}\0${st.size}`).digest('hex')
  }

  /**
   * The cached thumbnail of `real` (already confined by the caller), or what to
   * make one from. `.blend` previews are made here; `toDisplay` turns a path
   * into the `~/…` form for `source`.
   */
  async get(real: string, toDisplay: (p: string) => string): Promise<{ data: Buffer; type: string } | ThumbMissing> {
    const st = await fsp.stat(real).catch(() => null)
    if (!st) throw new StoreError('Not found', 404)
    const key = this.key(real, st)
    for (const [ext, type] of [
      ['webp', 'image/webp'],
      ['png', 'image/png'],
    ] as const) {
      const file = path.join(this.dir, `${key}.${ext}`)
      const data = await fsp.readFile(file).catch(() => null)
      if (data) {
        const now = new Date()
        await fsp.utimes(file, now, now).catch(() => {})
        return { data, type }
      }
    }
    if (st.isDirectory()) {
      const icon = await godotIcon(real)
      return icon ? { make: 'image', source: toDisplay(icon) } : { make: null }
    }
    const kind = assetKind(real)
    if (kind === 'blend') {
      const preview = await readBlendPreview(real).catch(() => null)
      if (!preview) return { make: null }
      const data = encodePng(preview.width, preview.height, preview.rgba, true)
      await this.#store(key, 'png', data)
      return { data, type: 'image/png' }
    }
    return { make: kind }
  }

  /** Keep a thumbnail the browser made for `real` (already confined by the caller). */
  async put(real: string, data: Buffer): Promise<void> {
    if (data.length > MAX_UPLOAD) throw new StoreError('A thumbnail is at most 512 KB', 413)
    const ext = isWebp(data) ? 'webp' : isPng(data) ? 'png' : null
    if (!ext) throw new StoreError('A thumbnail is a WebP or PNG image', 415)
    const st = await fsp.stat(real).catch(() => null)
    if (!st) throw new StoreError('Not found', 404)
    await this.#store(this.key(real, st), ext, data)
  }

  async #store(key: string, ext: string, data: Buffer) {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, `${key}.${ext}`)
    if (!within(file, this.dir)) throw new StoreError('Bad thumbnail name', 400)
    await writeAtomic(file, data)
    if (++this.#writes % 50 === 1) await this.prune().catch(() => {})
  }

  /** Delete the least recently used thumbnails once the cache passes its cap, down to 80% of it. */
  async prune(): Promise<number> {
    const names = await fsp.readdir(this.dir).catch(() => [] as string[])
    const files = []
    let total = 0
    for (const name of names) {
      if (!/^[0-9a-f]{40}\.(webp|png)$/.test(name)) continue
      const st = await fsp.stat(path.join(this.dir, name)).catch(() => null)
      if (!st) continue
      files.push({ name, size: st.size, at: st.mtimeMs })
      total += st.size
    }
    if (total <= this.#max) return 0
    let removed = 0
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= this.#max * 0.8) break
      await fsp.rm(path.join(this.dir, f.name), { force: true })
      total -= f.size
      removed++
    }
    return removed
  }
}

/** A Godot project folder's icon (`config/icon` in project.godot), if it is an image inside the folder. */
async function godotIcon(dir: string): Promise<string | null> {
  const text = await fsp.readFile(path.join(dir, 'project.godot'), 'utf8').catch(() => null)
  if (text === null) return null
  const rel = /^config\/icon\s*=\s*"res:\/\/([^"]+)"/m.exec(text)?.[1] ?? 'icon.svg'
  const icon = path.resolve(dir, rel)
  if (!within(icon, dir) || assetKind(icon) !== 'image') return null
  const real = await fsp.realpath(icon).catch(() => null)
  return real && within(real, dir) ? real : null
}

// .blend previews

export interface BlendPreview {
  width: number
  height: number
  /** RGBA, rows from the bottom up, as Blender stores them. */
  rgba: Buffer
}

/** Pulls bytes from a stream on demand, so a compressed file is only read as far as needed. */
class Reader {
  #it: AsyncIterator<Buffer>
  #buf = Buffer.alloc(0)
  #done = false
  read = 0

  constructor(stream: Readable) {
    this.#it = stream[Symbol.asyncIterator]()
  }

  async take(n: number): Promise<Buffer | null> {
    while (this.#buf.length < n && !this.#done) {
      const next = await this.#it.next()
      if (next.done) this.#done = true
      else this.#buf = Buffer.concat([this.#buf, next.value as Buffer])
    }
    if (this.#buf.length < n) return null
    const out = this.#buf.subarray(0, n)
    this.#buf = this.#buf.subarray(n)
    this.read += n
    return out
  }

  async skip(n: number): Promise<boolean> {
    while (n > 0) {
      const step = Math.min(n, 1024 * 1024)
      if (!(await this.take(step))) return false
      n -= step
    }
    return true
  }

  async close() {
    await this.#it.return?.()
  }
}

/** The preview image inside a .blend file (plain, gzip or zstd; the classic header or Blender 5's), or null. */
export async function readBlendPreview(file: string): Promise<BlendPreview | null> {
  const fd = await fsp.open(file, 'r')
  const magic = Buffer.alloc(4)
  await fd.read(magic, 0, 4, 0)
  await fd.close()
  let stream: Readable = fs.createReadStream(file)
  if (magic[0] === 0x1f && magic[1] === 0x8b) stream = stream.pipe(zlib.createGunzip())
  else if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) stream = stream.pipe(zlib.createZstdDecompress())
  const r = new Reader(stream)
  try {
    return await scanBlend(r)
  } finally {
    await r.close()
    stream.destroy()
  }
}

async function scanBlend(r: Reader): Promise<BlendPreview | null> {
  const start = await r.take(12)
  if (!start || start.toString('latin1', 0, 7) !== 'BLENDER') return null
  let ptr: number
  let little: boolean
  let large = false
  if (/^\d\d$/.test(start.toString('latin1', 7, 9))) {
    // Blender 5: `BLENDER` + header size (2 digits) + `-` + format version (2 digits) + endian + version (4 digits).
    const size = Number(start.toString('latin1', 7, 9))
    const rest = await r.take(size - 12)
    if (!rest) return null
    const header = Buffer.concat([start, rest]).toString('latin1')
    const format = Number(header.slice(10, 12))
    little = header[12] === 'v'
    ptr = 8
    large = format >= 1
  } else {
    // Classic: `BLENDER` + pointer size (`_` 4, `-` 8) + endian (`v` little, `V` big) + version (3 digits).
    ptr = start[7] === 0x2d ? 8 : 4
    little = start[8] === 0x76
  }
  const int = (b: Buffer, at: number) => (little ? b.readInt32LE(at) : b.readInt32BE(at))
  const long = (b: Buffer, at: number) => Number(little ? b.readBigInt64LE(at) : b.readBigInt64BE(at))
  const headSize = large ? 32 : 16 + ptr
  while (r.read < BLEND_SCAN) {
    const head = await r.take(headSize)
    if (!head) return null
    const code = head.toString('latin1', 0, 4)
    // Classic: code, len, old pointer, SDNA index, count. Large: code, SDNA index, old pointer, len, count.
    const len = large ? long(head, 16) : int(head, 4)
    if (code === 'ENDB' || len < 0) return null
    if (code === 'TEST') {
      const dims = await r.take(8)
      if (!dims) return null
      const [width, height] = [int(dims, 0), int(dims, 4)]
      if (width <= 0 || height <= 0 || width > 2048 || height > 2048 || 8 + width * height * 4 > len) return null
      const rgba = await r.take(width * height * 4)
      return rgba && { width, height, rgba: Buffer.from(rgba) }
    }
    if (!(await r.skip(len))) return null
  }
  return null
}

/** A PNG of RGBA pixels; `flip` turns bottom-up rows the right way round. Uses only zlib. */
export function encodePng(width: number, height: number, rgba: Buffer, flip = false): Buffer {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const src = flip ? height - 1 - y : y
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, src * stride, src * stride + stride)
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'latin1')
    data.copy(out, 8)
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
