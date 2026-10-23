// Drawer logos: small square PNGs in <config>/logos, named by their content.
// The browser scales a picture to 64×64 and sends the PNG; only that is kept,
// so a logo never outgrows the narrowest sidebar.
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StoreError } from './config-store.ts'
import { writeAtomic } from './fs-util.ts'
import { realish } from './paths.ts'
import { isPng } from './thumbs.ts'

export const LOGO_SIZE = 64
const MAX_BYTES = 64 * 1024
/** What `put` names a logo: 12 hex digits of its sha1. */
const NAME = /^[0-9a-f]{12}\.png$/

/** A PNG's width and height, from its IHDR chunk. */
export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (!isPng(b) || b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

export class Logos {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  /** Keep a logo; the same picture again gets the same name. */
  async put(body: Buffer): Promise<{ name: string }> {
    if (body.length > MAX_BYTES) throw new StoreError('A logo is at most 64 KB', 413)
    const size = pngSize(body)
    if (!size) throw new StoreError('A logo must be a PNG', 415)
    if (size.width > LOGO_SIZE || size.height > LOGO_SIZE || !size.width || !size.height) throw new StoreError(`A logo is at most ${LOGO_SIZE}×${LOGO_SIZE} pixels`, 422)
    const name = `${createHash('sha1').update(body).digest('hex').slice(0, 12)}.png`
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = path.join(this.dir, name)
    if (!(await fsp.stat(file).catch(() => null))) await writeAtomic(file, body)
    return { name }
  }

  /** A logo by name; anything else is not found. */
  async read(name: string): Promise<Buffer> {
    if (!NAME.test(name)) throw new StoreError('Not found', 404)
    const dir = await realish(this.dir)
    const real = await fsp.realpath(path.join(dir, name)).catch(() => null)
    if (!real || path.dirname(real) !== dir) throw new StoreError('Not found', 404)
    return fsp.readFile(real).catch(() => {
      throw new StoreError('Not found', 404)
    })
  }
}
