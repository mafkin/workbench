// The file browser's side of the service: listing folders, previews, tickets
// for media, and file operations. Every path is confined to the profile's
// folders (paths.ts). Deletes go to the Trash through gio; nothing is ever
// deleted outright, and nothing is overwritten.
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  displayPath,
  type FileEntry,
  type FileListing,
  type FileOp,
  type FileOpResult,
  type FileText,
  type MoveResult,
  type Profile,
} from '../shared/config-schema.ts'
import { StoreError, type ConfigStore } from './config-store.ts'
import { runDetached, runToExit } from './launch.ts'
import { IMAGE_TYPES } from './notes.ts'
import { absPath, browseRoots, inside, realish, within } from './paths.ts'
import { FolderWatcher } from './watch.ts'

const TEXT_LIMIT = 200 * 1024
const TICKET_MS = 10 * 60 * 1000
const MAX_WATCHED = 64

/** What a preview may load through a ticket; text goes through `text()` instead. */
export const MEDIA_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
}

export interface FilesEvent {
  /** A listed folder whose contents changed. */
  path: string
}

interface Options {
  spawn?: typeof nodeSpawn
  now?: () => number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const joinDisplay = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`

/** A single file name: not empty, no slash, not `.` or `..`. */
function checkName(raw: string): string {
  const name = raw.trim()
  if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new StoreError('Not a valid name', 400)
  if (Buffer.byteLength(name) > 255) throw new StoreError('That name is too long', 400)
  return name
}

const exists = (p: string) => fsp.lstat(p).then(() => true, () => false)

const alreadyExists = (name: string) => (err: NodeJS.ErrnoException) => {
  if (err.code === 'EEXIST') throw new StoreError(`${name} already exists`, 409)
  throw err
}

/** Names in `dir` that .gitignore excludes; none outside a git repository or without git. */
function gitIgnored(dir: string, entries: FileEntry[]): Promise<Set<string>> {
  const names = entries.filter((e) => e.name !== '.git').map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name))
  if (!names.length) return Promise.resolve(new Set())
  return new Promise((resolve) => {
    const child = execFile('git', ['check-ignore', '--stdin', '-z'], { cwd: dir, timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      // Exit 1 means nothing is ignored and 128 not a repository; stdout is empty for both.
      resolve(new Set(String(stdout).split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''))))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(names.join('\0'))
  })
}

export class Files extends EventEmitter {
  readonly home: string
  #store: ConfigStore
  #spawn: typeof nodeSpawn | undefined
  #now: () => number
  /** A file ticket serves one file; a folder ticket serves an HTML report and the files next to it. */
  #tickets = new Map<string, { kind: 'file'; real: string; type: string; expires: number } | { kind: 'folder'; dir: string; expires: number }>()
  /** Real folder -> the `~` paths it was listed as. */
  #listed = new Map<string, Set<string>>()
  #timers = new Map<string, NodeJS.Timeout>()
  #folders = new FolderWatcher(MAX_WATCHED, {
    change: (dir) => this.#changed(dir),
    replaced: (dir) => this.#changed(dir),
    dropped: (dir) => this.#listed.delete(dir),
  })

  constructor(store: ConfigStore, home: string, opts: Options = {}) {
    super()
    this.#store = store
    this.home = home
    this.#spawn = opts.spawn
    this.#now = opts.now ?? Date.now
  }

  close() {
    this.#folders.close()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#timers.clear()
  }

  /** A folder's entries, folders first; dotfiles and ignored files are flagged, not left out. */
  async list(id: string, raw: string): Promise<FileListing> {
    const { real, display } = await this.#resolve(id, raw)
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) throw new StoreError('Not found', 404)
    if (!stat.isDirectory()) throw new StoreError('Not a folder', 400)
    const entries: FileEntry[] = []
    for (const d of await fsp.readdir(real, { withFileTypes: true })) {
      const full = path.join(real, d.name)
      const lst = await fsp.lstat(full).catch(() => null)
      if (!lst) continue
      const link = lst.isSymbolicLink()
      const st = link ? await fsp.stat(full).catch(() => null) : lst
      const kind = st?.isDirectory() ? 'dir' : st?.isFile() ? 'file' : 'other'
      entries.push({
        name: d.name,
        path: joinDisplay(display, d.name),
        kind,
        link,
        size: kind === 'file' ? st!.size : 0,
        mtime: (st ?? lst).mtimeMs,
        hidden: d.name.startsWith('.'),
        ignored: false,
      })
    }
    const ignored = await gitIgnored(real, entries)
    for (const e of entries) e.ignored = ignored.has(e.name)
    entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || collator.compare(a.name, b.name))
    this.#watch(real, display)
    return { path: display, entries }
  }

  /** The start of a file for a text preview. */
  async text(id: string, raw: string): Promise<FileText> {
    const { real } = await this.#resolve(id, raw)
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) throw new StoreError('Not found', 404)
    if (!stat.isFile()) throw new StoreError('Not a file', 400)
    const handle = await fsp.open(real, 'r')
    try {
      const buf = Buffer.alloc(Math.min(stat.size, TEXT_LIMIT))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      const data = buf.subarray(0, bytesRead)
      const binary = data.subarray(0, 8000).includes(0)
      return { text: binary ? '' : data.toString('utf8'), truncated: stat.size > TEXT_LIMIT, binary, size: stat.size }
    } finally {
      await handle.close()
    }
  }

  /**
   * A short-lived URL for an image, PDF, video or audio file. Media elements
   * cannot send the X-Workbench header, so the app asks for this with it.
   * With `folder`, an HTML report gets a URL whose folder serves the files next
   * to it (its CSS, scripts and images), and nothing outside that folder.
   */
  async ticket(id: string, raw: string, opts: { folder?: boolean } = {}): Promise<{ url: string }> {
    const { real, display } = await this.#resolve(id, raw)
    const type = MEDIA_TYPES[path.extname(real).toLowerCase()]
    if (opts.folder ? !/\.html?$/i.test(real) : !type) {
      throw new StoreError(opts.folder ? 'Only an HTML report opens with its folder' : 'No preview for this type of file', 415)
    }
    if (!(await fsp.stat(real).catch(() => null))?.isFile()) throw new StoreError('Not found', 404)
    const now = this.#now()
    for (const [token, t] of this.#tickets) if (t.expires <= now) this.#tickets.delete(token)
    const token = randomBytes(24).toString('base64url')
    const expires = now + TICKET_MS
    this.#tickets.set(token, opts.folder ? { kind: 'folder', dir: path.dirname(real), expires } : { kind: 'file', real, type, expires })
    return { url: `/raw/${token}/${encodeURIComponent(path.basename(opts.folder ? real : display))}` }
  }

  /** The file a single-file ticket serves. */
  raw(token: string): { real: string; type: string } | null {
    const t = this.#live(token)
    return t?.kind === 'file' ? { real: t.real, type: t.type } : null
  }

  /** What `/raw/<token>/<rel>` serves: a file ticket's file, or a file inside a folder ticket's folder. */
  async rawFile(token: string, rel: string): Promise<{ real: string; type?: string } | null> {
    const t = this.#live(token)
    if (!t) return null
    if (t.kind === 'file') return { real: t.real, type: t.type }
    const target = path.resolve(t.dir, rel)
    if (!within(target, t.dir)) return null
    const real = await fsp.realpath(target).catch(() => null)
    if (!real || !within(real, t.dir)) return null
    return (await fsp.stat(real)).isFile() ? { real } : null
  }

  #live(token: string) {
    const t = this.#tickets.get(token)
    if (!t) return null
    if (t.expires <= this.#now()) {
      this.#tickets.delete(token)
      return null
    }
    return t
  }

  /** Open with the desktop's default app; launchers and executables are refused. */
  async open(id: string, raw: string): Promise<void> {
    const { real } = await this.#resolve(id, raw)
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) throw new StoreError('Not found', 404)
    if (stat.isFile() && (/\.desktop$/i.test(real) || stat.mode & 0o111)) {
      throw new StoreError('Workbench does not start launchers or programs; use Open folder in Files', 403)
    }
    await runDetached({ command: 'xdg-open', args: [real] }, this.#spawn)
  }

  async op(id: string, op: FileOp): Promise<FileOpResult> {
    switch (op.op) {
      case 'rename': {
        const src = await this.#entry(id, op.path)
        const name = checkName(op.name)
        const dest = path.join(path.dirname(src.real), name)
        if (dest === src.real) return { path: src.display }
        if (await exists(dest)) throw new StoreError(`${name} already exists`, 409)
        await fsp.rename(src.real, dest)
        return { path: joinDisplay(path.posix.dirname(src.display), name) }
      }
      case 'mkdir':
      case 'touch': {
        const dir = await this.#resolve(id, op.dir)
        const name = checkName(op.name)
        const dest = path.join(dir.real, name)
        if (op.op === 'mkdir') await fsp.mkdir(dest).catch(alreadyExists(name))
        else await fsp.writeFile(dest, '', { flag: 'wx' }).catch(alreadyExists(name))
        return { path: joinDisplay(dir.display, name) }
      }
      case 'move': {
        const to = await this.#resolve(id, op.to)
        if (!(await fsp.stat(to.real).catch(() => null))?.isDirectory()) throw new StoreError('Not a folder', 400)
        const result: MoveResult = { moved: [], skipped: [] }
        for (const p of op.paths) {
          const src = await this.#entry(id, p)
          const name = path.basename(src.real)
          const dest = path.join(to.real, name)
          const skip = (reason: string) => result.skipped.push({ path: src.display, reason })
          if (within(to.real, src.real)) skip('A folder cannot go inside itself')
          else if (path.dirname(src.real) === to.real) skip('It is already there')
          else if (await exists(dest)) skip(`${name} already exists there`)
          else {
            try {
              await fsp.rename(src.real, dest)
              result.moved.push({ from: src.display, to: joinDisplay(to.display, name) })
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
              skip('It is on another drive; move it in Files')
            }
          }
        }
        return result
      }
      case 'trash': {
        const srcs = []
        for (const p of op.paths) srcs.push(await this.#entry(id, p))
        await runToExit({ command: 'gio', args: ['trash', '--', ...srcs.map((s) => s.real)] }, this.#spawn)
        return { trashed: srcs.map((s) => s.display) }
      }
    }
  }

  #profile(id: string): Profile {
    const p = this.#store.profile(id)
    if (!p.profile) throw new StoreError(`${id}.yaml has an error; fix it first`, 423)
    return p.profile
  }

  /** A path to read: symlinks followed, and it must be one of the profile's folders or inside one. */
  async #resolve(id: string, raw: string): Promise<{ real: string; display: string }> {
    const profile = this.#profile(id)
    const lexical = absPath(raw, this.home)
    const real = await realish(lexical)
    if (!(await browseRoots(profile, this.home)).some((r) => within(real, r.real))) {
      throw new StoreError("Outside this profile's folders", 403)
    }
    return { real, display: displayPath(lexical, this.home) }
  }

  /**
   * A file or folder to rename, move or trash. Only its folder is resolved, so a
   * symlink is acted on itself, not what it points to. The profile's folders
   * themselves, and folders holding one, are off limits.
   */
  async #entry(id: string, raw: string): Promise<{ real: string; display: string }> {
    const profile = this.#profile(id)
    const lexical = absPath(raw, this.home)
    const real = path.join(await realish(path.dirname(lexical)), path.basename(lexical))
    const display = displayPath(lexical, this.home)
    const roots = await browseRoots(profile, this.home)
    if (!roots.some((r) => inside(real, r.real))) throw new StoreError("Outside this profile's folders", 403)
    if (roots.some((r) => within(r.real, real))) throw new StoreError(`${display} is one of this profile's folders or holds one`, 403)
    if (!(await exists(real))) throw new StoreError('Not found', 404)
    return { real, display }
  }

  #watch(real: string, display: string) {
    const shown = this.#listed.get(real)
    if (shown) shown.add(display)
    else this.#listed.set(real, new Set([display]))
    this.#folders.watch(real)
  }

  #changed(dir: string) {
    if (!this.#listed.has(dir)) return
    clearTimeout(this.#timers.get(dir))
    this.#timers.set(
      dir,
      setTimeout(() => {
        this.#timers.delete(dir)
        for (const p of this.#listed.get(dir) ?? []) this.emit('files', { path: p } satisfies FilesEvent)
      }, 100),
    )
  }
}
