// Background pictures: copies kept in <config>/backgrounds, chosen per profile
// (`background:` names one). A copy keeps working when the original moves.
// Pictures come only from the profile's folders, and only raster types are
// kept or served (an SVG could carry scripts).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StoreError } from './config-store.ts'
import type { Wiki } from './wiki.ts'
import { absPath, browseRoots, realish, within } from './paths.ts'

export const PICTURE_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
}
const MAX_SIZE = 25 * 1024 * 1024
/** A plain file name of a picture: no folders, no leading dot. */
const NAME = /^[A-Za-z0-9_][\w .-]*$/

const typeOf = (name: string) => PICTURE_TYPES[path.extname(name).toLowerCase()]

async function hashOf(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export class Backgrounds {
  readonly dir: string
  #store: Wiki
  #home: string

  constructor(dir: string, store: Wiki, home: string) {
    this.dir = dir
    this.#store = store
    this.#home = home
  }

  async list(): Promise<string[]> {
    let names: string[]
    try {
      names = await fsp.readdir(this.dir)
    } catch {
      return []
    }
    const out: string[] = []
    for (const n of names.filter((n) => NAME.test(n) && typeOf(n))) {
      if ((await fsp.stat(path.join(this.dir, n)).catch(() => null))?.isFile()) out.push(n)
    }
    return out.sort((a, b) => a.localeCompare(b))
  }

  /** A picture in the folder by name; anything else is not found. */
  async read(name: string): Promise<{ real: string; type: string; size: number }> {
    const type = typeOf(name)
    if (!NAME.test(name) || !type) throw new StoreError('Not found', 404)
    const dir = await realish(this.dir)
    const real = await fsp.realpath(path.join(dir, name)).catch(() => null)
    const stat = real ? await fsp.stat(real).catch(() => null) : null
    if (!real || !stat?.isFile() || path.dirname(real) !== dir) throw new StoreError('Not found', 404)
    return { real, type, size: stat.size }
  }

  /** Copy a picture from the profile's folders; the same picture again keeps its name. */
  async add(profileId: string, raw: string): Promise<{ name: string }> {
    const p = this.#store.profile(profileId)
    if (!p.profile) throw new StoreError(`${profileId}.yaml has an error; fix it first`, 423)
    const real = await realish(absPath(raw, this.#home))
    if (!(await browseRoots(p.profile, this.#home)).some((r) => within(real, r.real))) {
      throw new StoreError("Outside this profile's folders", 403)
    }
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat?.isFile()) throw new StoreError('Not found', 404)
    if (!typeOf(real)) throw new StoreError('Only jpg, png, webp, avif or gif pictures', 415)
    if (stat.size > MAX_SIZE) throw new StoreError('Pictures up to 25 MB', 413)

    await fsp.mkdir(this.dir, { recursive: true })
    const ext = path.extname(real).toLowerCase()
    const stem = path.basename(real, path.extname(real)).replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9_]+/, '').slice(0, 80) || 'picture'
    const hash = await hashOf(real)
    for (let n = 1; ; n++) {
      const name = `${stem}${n === 1 ? '' : `-${n}`}${ext}`
      const target = path.join(this.dir, name)
      if (!fs.existsSync(target)) {
        const tmp = path.join(this.dir, `.${name}.${process.pid}.tmp`)
        await fsp.copyFile(real, tmp)
        await fsp.rename(tmp, target)
        return { name }
      }
      if ((await hashOf(target)) === hash) return { name }
    }
  }

  async remove(name: string) {
    const { real } = await this.read(name)
    await fsp.unlink(real)
  }
}
