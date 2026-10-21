// Notes: Markdown files the UI reads and writes. Every path is checked against
// the profile's notes folder and its note entries after resolving symlinks, so
// the service never touches any other file. Saves carry the rev they started
// from, like profile edits, and a hand edit to an open note is reported live.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  displayPath,
  expandHome,
  NOTE_EXT,
  type NavItem,
  type NoteFile,
  type NoteSummary,
  type Profile,
  type SearchHit,
  type SearchLine,
} from '../shared/config-schema.ts'
import { StoreError, type ConfigStore } from './config-store.ts'
import { revOf, writeAtomic } from './fs-util.ts'

const MAX_NOTE = 2 * 1024 * 1024
const MAX_IMAGE = 20 * 1024 * 1024
const MAX_FILES = 5000
const MAX_DEPTH = 8
const MAX_HITS = 50
const MAX_LINES = 3
const LINE_WINDOW = 200
const MAX_WATCHED = 32

export const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

export interface NoteEvent {
  path: string
  /** Null when the file is gone. */
  rev: string | null
}

interface Roots {
  root: { lexical: string; real: string } | null
  /** Note entries: real path -> `~` path as written in the config. */
  entries: Map<string, string>
}

interface Found extends NoteSummary {
  real: string
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

const baseName = (file: string) => path.parse(file).name

/** realpath of the longest existing prefix plus the rest; a dangling symlink is refused. */
async function realish(p: string): Promise<string> {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest.reverse())
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      if ((await fsp.lstat(cur).catch(() => null))?.isSymbolicLink()) throw new StoreError('Not allowed: broken symlink', 403)
      const parent = path.dirname(cur)
      if (parent === cur) return p
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

function noteEntries(profile: Profile): string[] {
  const out: string[] = []
  const visit = (items: NavItem[]) => {
    for (const item of items) {
      if (item.type === 'note') out.push(item.path)
      else if (item.type === 'group') visit(item.items)
    }
  }
  for (const s of profile.sections) visit(s.items)
  return out
}

/** Matching lines, at most MAX_LINES, long lines cut to a window around the first match. */
function matchLines(text: string, terms: string[]): SearchLine[] {
  const out: SearchLine[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < MAX_LINES; i++) {
    const line = lines[i].replace(/\r$/, '')
    const lower = line.toLowerCase()
    let ranges: [number, number][] = []
    for (const term of terms) {
      for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) ranges.push([at, at + term.length])
    }
    if (!ranges.length) continue
    ranges.sort((a, b) => a[0] - b[0])
    let shown = line
    if (line.length > LINE_WINDOW) {
      const start = Math.max(0, ranges[0][0] - 60)
      const end = Math.min(line.length, start + LINE_WINDOW)
      const lead = start > 0 ? '…' : ''
      shown = `${lead}${line.slice(start, end)}${end < line.length ? '…' : ''}`
      ranges = ranges
        .filter(([s, e]) => s >= start && e <= end)
        .map(([s, e]) => [s - start + lead.length, e - start + lead.length])
    }
    out.push({ line: i + 1, text: shown, ranges })
  }
  return out
}

export class Notes extends EventEmitter {
  readonly home: string
  #store: ConfigStore
  #queues = new Map<string, Promise<unknown>>()
  /** Watched folders, oldest first. */
  #watchers = new Map<string, fs.FSWatcher>()
  /** Real path of each opened note -> the `~` paths it was opened as, and its last known rev. */
  #open = new Map<string, { paths: Set<string>; rev: string | null }>()
  #timers = new Map<string, NodeJS.Timeout>()

  constructor(store: ConfigStore, home: string) {
    super()
    this.#store = store
    this.home = home
  }

  close() {
    for (const w of this.#watchers.values()) w.close()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#watchers.clear()
    this.#timers.clear()
  }

  async read(id: string, raw: string): Promise<NoteFile> {
    const { real, display } = await this.#resolve(id, raw, 'note')
    this.#watch(real, display)
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) throw new StoreError('Not found', 404)
    if (!stat.isFile()) throw new StoreError('Not a file', 400)
    if (stat.size > MAX_NOTE) throw new StoreError('Too large to open as a note (over 2 MB)', 413)
    const text = await fsp.readFile(real, 'utf8')
    const rev = revOf(text)
    this.#open.get(real)!.rev = rev
    return { path: display, text, rev, mtime: stat.mtimeMs }
  }

  /** Save `text` if the file is still at `rev`; `rev: null` creates a new file and never overwrites. */
  async write(id: string, raw: string, rev: string | null, text: string): Promise<{ path: string; rev: string; mtime: number }> {
    if (Buffer.byteLength(text) > MAX_NOTE) throw new StoreError('Too large to save as a note (over 2 MB)', 413)
    const { real, display } = await this.#resolve(id, raw, 'note')
    return this.#serial(real, async () => {
      const current = await fsp.readFile(real, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (rev === null) {
        if (current !== null) throw new StoreError('A note with that name already exists', 409, { rev: revOf(current) })
      } else if (current === null) {
        throw new StoreError('The note was deleted on disk', 409, { rev: null })
      } else if (revOf(current) !== rev) {
        throw new StoreError('The note changed on disk', 409, { rev: revOf(current) })
      }
      const mode = current === null ? undefined : (await fsp.stat(real)).mode & 0o7777
      await fsp.mkdir(path.dirname(real), { recursive: true })
      await writeAtomic(real, text, mode)
      const saved = revOf(text)
      this.#watch(real, display)
      const open = this.#open.get(real)!
      open.rev = saved
      // The watcher skips a rev it already knows, so report the save here for other windows.
      for (const p of open.paths) this.emit('note', { path: p, rev: saved } satisfies NoteEvent)
      return { path: display, rev: saved, mtime: (await fsp.stat(real)).mtimeMs }
    })
  }

  /** Markdown in the notes folder plus the note entries, newest first. */
  async list(id: string): Promise<NoteSummary[]> {
    return (await this.#collect(id)).map(({ real: _real, ...n }) => n)
  }

  /** Notes containing every word of `query` (ignoring case), title matches first. An empty query lists notes. */
  async search(id: string, query: string): Promise<SearchHit[]> {
    const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
    const found = await this.#collect(id)
    if (!terms.length) return found.slice(0, MAX_HITS).map(({ real: _real, ...n }) => ({ ...n, title: false, lines: [] }))
    const hits: SearchHit[] = []
    for (const { real, ...n } of found) {
      const stat = await fsp.stat(real).catch(() => null)
      if (!stat || stat.size > MAX_NOTE) continue
      const text = await fsp.readFile(real, 'utf8').catch(() => '')
      const name = n.name.toLowerCase()
      const lower = text.toLowerCase()
      if (!terms.every((t) => name.includes(t) || lower.includes(t))) continue
      hits.push({ ...n, title: terms.every((t) => name.includes(t)), lines: matchLines(text, terms) })
    }
    // `found` is newest first and the sort is stable.
    return hits.sort((a, b) => Number(b.title) - Number(a.title)).slice(0, MAX_HITS)
  }

  /** An image in the notes folder or next to a note entry, for rendering in a note. */
  async asset(id: string, raw: string): Promise<{ real: string; type: string; size: number }> {
    const { real } = await this.#resolve(id, raw, 'image')
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat?.isFile()) throw new StoreError('Not found', 404)
    if (stat.size > MAX_IMAGE) throw new StoreError('Image too large', 413)
    return { real, type: IMAGE_TYPES[path.extname(real).toLowerCase()], size: stat.size }
  }

  #profile(id: string): Profile {
    const p = this.#store.profile(id)
    if (!p.profile) throw new StoreError(`${id}.yaml has an error; fix it first`, 423)
    return p.profile
  }

  #abs(raw: string): string {
    const value = raw.trim()
    if (!value) throw new StoreError('path is required', 400)
    const expanded = expandHome(value, this.home)
    if (!path.isAbsolute(expanded)) throw new StoreError('Path must start with ~ or /', 400)
    return path.resolve(expanded)
  }

  async #roots(profile: Profile): Promise<Roots> {
    let root: Roots['root'] = null
    if (profile.notes) {
      const lexical = this.#abs(profile.notes)
      root = { lexical, real: await realish(lexical) }
    }
    const entries = new Map<string, string>()
    for (const p of noteEntries(profile)) {
      try {
        const lexical = this.#abs(p)
        const real = await realish(lexical)
        if (!entries.has(real)) entries.set(real, displayPath(lexical, this.home))
      } catch {
        // An entry whose path cannot be resolved allows nothing.
      }
    }
    return { root, entries }
  }

  async #resolve(id: string, raw: string, kind: 'note' | 'image'): Promise<{ real: string; display: string }> {
    const profile = this.#profile(id)
    const lexical = this.#abs(raw)
    const real = await realish(lexical)
    const { root, entries } = await this.#roots(profile)
    const inRoot = !!root && inside(real, root.real)
    const ok =
      kind === 'note'
        ? (inRoot && NOTE_EXT.test(real)) || entries.has(real)
        : !!IMAGE_TYPES[path.extname(real).toLowerCase()] && (inRoot || [...entries.keys()].some((e) => inside(real, path.dirname(e))))
    if (!ok) throw new StoreError(kind === 'note' ? 'Not a note in this profile' : 'Not an image next to a note in this profile', 403)
    return { real, display: displayPath(lexical, this.home) }
  }

  async #collect(id: string): Promise<Found[]> {
    const { root, entries } = await this.#roots(this.#profile(id))
    const found = new Map<string, Found>()
    if (root) {
      const walk = async (dir: string, rel: string, depth: number) => {
        const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const d of list) {
          if (found.size >= MAX_FILES) return
          // Dot-folders hold trash, git and editor state; symlinks may lead outside.
          if (d.name.startsWith('.') || d.name === 'node_modules' || d.isSymbolicLink()) continue
          const childRel = rel ? `${rel}/${d.name}` : d.name
          const real = path.join(dir, d.name)
          if (d.isDirectory() && depth < MAX_DEPTH) await walk(real, childRel, depth + 1)
          else if (d.isFile() && NOTE_EXT.test(d.name)) {
            const stat = await fsp.stat(real).catch(() => null)
            if (!stat) continue
            const display = displayPath(path.join(root.lexical, childRel), this.home)
            found.set(real, { real, path: display, name: baseName(d.name), rel: childRel, mtime: stat.mtimeMs })
          }
        }
      }
      await walk(root.real, '', 0)
    }
    for (const [real, display] of entries) {
      if (found.has(real)) continue
      const stat = await fsp.stat(real).catch(() => null)
      if (!stat?.isFile()) continue
      const rel = root && inside(real, root.real) ? path.relative(root.real, real).split(path.sep).join('/') : null
      found.set(real, { real, path: display, name: baseName(real), rel, mtime: stat.mtimeMs })
    }
    return [...found.values()].sort((a, b) => b.mtime - a.mtime)
  }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(key) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => {})
    this.#queues.set(key, tail)
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    })
    return run
  }

  /** Watch the note's folder, not the file: editors and our own saves replace the file. */
  #watch(real: string, display: string) {
    const open = this.#open.get(real)
    if (open) open.paths.add(display)
    else this.#open.set(real, { paths: new Set([display]), rev: null })
    const dir = path.dirname(real)
    const existing = this.#watchers.get(dir)
    if (existing) {
      this.#watchers.delete(dir)
      this.#watchers.set(dir, existing)
      return
    }
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (!name) return
        if (name === path.basename(dir)) this.#replaced(dir)
        else this.#changed(path.join(dir, name))
      })
    } catch {
      return // The folder does not exist yet.
    }
    watcher.on('error', () => this.#unwatch(dir))
    this.#watchers.set(dir, watcher)
    if (this.#watchers.size > MAX_WATCHED) this.#unwatch(this.#watchers.keys().next().value!)
  }

  /**
   * The watched folder itself was deleted or moved, and its watch has gone
   * quiet without an error. Watch it again once it is back, and look at its open notes.
   */
  #replaced(dir: string) {
    this.#watchers.get(dir)?.close()
    this.#watchers.delete(dir)
    clearTimeout(this.#timers.get(dir))
    this.#timers.set(
      dir,
      setTimeout(() => {
        this.#timers.delete(dir)
        for (const [file, open] of this.#open) {
          if (path.dirname(file) !== dir) continue
          for (const p of open.paths) this.#watch(file, p)
          this.#changed(file)
        }
      }, 200),
    )
  }

  #unwatch(dir: string) {
    this.#watchers.get(dir)?.close()
    this.#watchers.delete(dir)
    for (const file of this.#open.keys()) if (path.dirname(file) === dir) this.#open.delete(file)
  }

  #changed(file: string) {
    if (!this.#open.has(file)) return
    clearTimeout(this.#timers.get(file))
    this.#timers.set(
      file,
      setTimeout(async () => {
        this.#timers.delete(file)
        const rev = await fsp.readFile(file, 'utf8').then(revOf, () => null)
        const open = this.#open.get(file)
        if (!open || open.rev === rev) return
        open.rev = rev
        for (const p of open.paths) this.emit('note', { path: p, rev } satisfies NoteEvent)
      }, 60),
    )
  }
}
