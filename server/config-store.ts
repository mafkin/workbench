// Profiles and settings on disk. The files are the source of truth: hand edits
// are picked up by a watcher, app edits are applied to the parsed document and
// written atomically, and a file the user has broken is never overwritten.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { isSeq, LineCounter, parseDocument, type Document } from 'yaml'
import {
  Profile,
  PROFILE_ID,
  PROFILE_ID_RULE,
  Settings,
  type AppState,
  type ConfigError,
  type Op,
  type ProfileState,
} from '../shared/config-schema.ts'
import { applyOps, describeIssue, OpError } from './config-ops.ts'
import { revOf, writeAtomic } from './fs-util.ts'
import { seedConfig } from './seed.ts'

export class StoreError extends Error {
  status: number
  /** Extra fields for the response body, e.g. the current rev on a conflict. */
  data?: Record<string, unknown>
  constructor(message: string, status: number, data?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

interface Entry extends ProfileState {
  text: string
  /** Content before the last app edit, restorable while the file still has that edit. */
  undo?: { text: string; revAfter: string }
}

export function parseProfile(text: string): { profile: Profile | null; error: ConfigError | null } {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false })
  const yamlError = doc.errors[0]
  if (yamlError) {
    const pos = lineCounter.linePos(yamlError.pos[0])
    return { profile: null, error: { message: yamlError.message.split('\n')[0], line: pos.line, col: pos.col } }
  }
  const result = Profile.safeParse(doc.toJS())
  if (result.success) return { profile: result.data, error: null }
  // Point at the closest node that exists, e.g. the item missing a required field.
  let at = result.error.issues[0]?.path ?? []
  let range: [number, number, number] | undefined
  for (;;) {
    const node = doc.getIn(at, true) as { range?: [number, number, number] } | undefined
    if (node?.range) {
      range = node.range
      break
    }
    if (at.length === 0) break
    at = at.slice(0, -1)
  }
  const pos = range ? lineCounter.linePos(range[0]) : undefined
  return { profile: null, error: { message: describeIssue(result.error), line: pos?.line, col: pos?.col } }
}

export class ConfigStore extends EventEmitter {
  readonly dir: string
  readonly profilesDir: string
  readonly settingsFile: string
  #entries = new Map<string, Entry>()
  #settings: Settings = { profiles: [] }
  #settingsText = ''
  #watchers: fs.FSWatcher[] = []
  #timers = new Map<string, NodeJS.Timeout>()
  #queue: Promise<unknown> = Promise.resolve()
  #ready = false

  constructor(dir: string) {
    super()
    this.dir = dir
    this.profilesDir = path.join(dir, 'profiles')
    this.settingsFile = path.join(dir, 'settings.yaml')
  }

  async init({ seed = true, watch = true } = {}) {
    await fsp.mkdir(this.profilesDir, { recursive: true })
    const existing = (await fsp.readdir(this.profilesDir)).filter((f) => f.endsWith('.yaml'))
    if (seed && existing.length === 0) await seedConfig(this.dir)
    await this.#loadSettings()
    for (const f of (await fsp.readdir(this.profilesDir)).filter(isProfileFile)) await this.#loadProfile(f)
    if (watch) this.#watch()
    this.#ready = true
  }

  close() {
    for (const w of this.#watchers) w.close()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#watchers = []
  }

  /** Everything but `home`, which the server adds. */
  state(): Omit<AppState, 'home'> {
    const ids = [...this.#entries.keys()]
    const order = [
      ...this.#settings.profiles.filter((id) => this.#entries.has(id)),
      ...ids.filter((id) => !this.#settings.profiles.includes(id)).sort(),
    ]
    const active = this.#settings.activeProfile && this.#entries.has(this.#settings.activeProfile)
      ? this.#settings.activeProfile
      : (order[0] ?? '')
    return {
      activeProfile: active,
      profiles: order.map((id) => {
        const { text: _text, undo: _undo, ...state } = this.#entries.get(id)!
        return state
      }),
    }
  }

  profile(id: string): ProfileState {
    const e = this.#entries.get(id)
    if (!e) throw new StoreError(`No profile "${id}"`, 404)
    return e
  }

  /** A profile file's text, as last read. */
  text(id: string): string {
    const e = this.#entries.get(id)
    if (!e) throw new StoreError(`No profile "${id}"`, 404)
    return e.text
  }

  /** Apply edits made in the UI. `rev` is the revision the UI last saw. */
  apply(id: string, rev: string, ops: Op[]): Promise<{ rev: string }> {
    return this.#serial(async () => {
      const e = await this.#current(id, rev)
      const doc = parseDocument(e.text)
      try {
        applyOps(doc, ops, e.text)
      } catch (err) {
        if (err instanceof OpError) throw new StoreError(err.message, 400)
        throw err
      }
      await this.#writeProfile(e, doc.toString(), true)
      return { rev: e.rev }
    })
  }

  /** Restore the content from before the last app edit. */
  undo(id: string, rev: string): Promise<{ rev: string }> {
    return this.#serial(async () => {
      const e = await this.#current(id, rev)
      if (!e.undo || e.undo.revAfter !== e.rev) throw new StoreError('Nothing to undo', 409)
      const { text } = e.undo
      await this.#writeProfile(e, text, false)
      return { rev: e.rev }
    })
  }

  setActive(id: string): Promise<void> {
    return this.#serial(async () => {
      this.profile(id)
      const lineCounter = new LineCounter()
      const doc = parseDocument(this.#settingsText || '{}', { lineCounter })
      if (doc.errors.length) throw new StoreError('settings.yaml has an error; fix it first', 423)
      doc.set('activeProfile', id)
      const text = doc.toString()
      await writeAtomic(this.settingsFile, text)
      this.#applySettingsText(text)
      this.emit('change')
    })
  }

  /** A new profile file (never over an existing one), last in the switcher. */
  createProfile(id: string, text: string): Promise<void> {
    return this.#serial(async () => {
      if (!PROFILE_ID.test(id)) throw new StoreError(PROFILE_ID_RULE, 400)
      if (this.#entries.has(id)) throw new StoreError(`There is already a profile "${id}"`, 409)
      const parsed = parseProfile(text)
      if (parsed.error) throw new StoreError(parsed.error.message, 400)
      const file = path.join(this.profilesDir, `${id}.yaml`)
      await fsp.writeFile(file, text, { flag: 'wx' }).catch((err) => {
        throw err.code === 'EEXIST' ? new StoreError(`${id}.yaml already exists`, 409) : err
      })
      const entry: Entry = { id, file, rev: '', text: '', profile: null, error: null }
      this.#setText(entry, text)
      const order = this.state().profiles.map((p) => p.id)
      this.#entries.set(id, entry)
      await this.#editSettings((doc) => setOrder(doc, [...order, id]))
      this.emit('change')
    })
  }

  /** Remove a profile: `trash` moves its file to the Trash; it leaves the switcher. The last one stays. */
  removeProfile(id: string, trash: (file: string) => Promise<void>): Promise<void> {
    return this.#serial(async () => {
      const e = this.profile(id)
      if (this.#entries.size <= 1) throw new StoreError('The last profile cannot be removed', 409)
      const state = this.state()
      await trash(e.file)
      this.#entries.delete(id)
      const order = state.profiles.map((p) => p.id).filter((p) => p !== id)
      await this.#editSettings((doc) => {
        setOrder(doc, order)
        if (state.activeProfile === id) doc.set('activeProfile', order[0])
      })
      this.emit('change')
    })
  }

  /** Edit settings.yaml, keeping its comments. */
  async #editSettings(edit: (doc: Document) => void) {
    const doc = parseDocument(this.#settingsText || '{}')
    if (doc.errors.length) throw new StoreError('settings.yaml has an error; fix it first', 423)
    edit(doc)
    const text = doc.toString()
    await writeAtomic(this.settingsFile, text)
    this.#applySettingsText(text)
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    this.#queue = run.catch(() => {})
    return run
  }

  /** The entry, checked against the UI's revision and against the file on disk. */
  async #current(id: string, rev: string): Promise<Entry> {
    const e = this.#entries.get(id)
    if (!e) throw new StoreError(`No profile "${id}"`, 404)
    // The watcher may not have caught up with a hand edit yet.
    const disk = await fsp.readFile(e.file, 'utf8').catch(() => null)
    if (disk !== null && disk !== e.text) {
      this.#setText(e, disk)
      e.undo = undefined
      this.emit('change')
    }
    if (e.error) {
      throw new StoreError(`${path.basename(e.file)} has an error${e.error.line ? ` on line ${e.error.line}` : ''}; fix it first`, 423)
    }
    if (rev !== e.rev) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    return e
  }

  async #writeProfile(e: Entry, text: string, keepUndo: boolean) {
    const before = e.text
    await writeAtomic(e.file, text)
    this.#setText(e, text)
    e.undo = keepUndo ? { text: before, revAfter: e.rev } : undefined
    this.emit('change')
  }

  #setText(e: Entry, text: string) {
    const { profile, error } = parseProfile(text)
    e.text = text
    e.rev = revOf(text)
    e.error = error
    if (profile) e.profile = profile
  }

  async #loadProfile(file: string) {
    const id = path.basename(file, '.yaml')
    const full = path.join(this.profilesDir, file)
    const text = await fsp.readFile(full, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    const e = this.#entries.get(id)
    if (text === null) {
      if (e) {
        this.#entries.delete(id)
        this.emit('change')
      }
      return
    }
    if (e && e.text === text) return
    const entry: Entry = e ?? { id, file: full, rev: '', text: '', profile: null, error: null }
    this.#setText(entry, text)
    entry.undo = undefined
    this.#entries.set(id, entry)
    if (this.#ready) this.emit('change')
  }

  async #loadSettings() {
    const text = await fsp.readFile(this.settingsFile, 'utf8').catch(() => '')
    if (text === this.#settingsText && text) return false
    this.#applySettingsText(text)
    return true
  }

  #applySettingsText(text: string) {
    this.#settingsText = text
    const parsed = Settings.safeParse(parseDocument(text).toJS() ?? {})
    this.#settings = parsed.success ? parsed.data : { profiles: [] }
  }

  #watch() {
    const debounce = (key: string, fn: () => Promise<unknown>) => {
      clearTimeout(this.#timers.get(key))
      this.#timers.set(
        key,
        setTimeout(() => {
          this.#timers.delete(key)
          fn().catch((err) => this.emit('error', err))
        }, 60),
      )
    }
    this.#watchers.push(
      fs.watch(this.profilesDir, (_event, name) => {
        if (name && isProfileFile(name)) debounce(name, () => this.#loadProfile(name))
      }),
      fs.watch(this.dir, (_event, name) => {
        if (name === 'settings.yaml') {
          debounce(name, async () => {
            if (await this.#loadSettings()) this.emit('change')
          })
        }
      }),
    )
  }
}

/** The switcher's order, keeping a flow list (`[work, personal]`) flow. */
function setOrder(doc: Document, order: string[]) {
  const node = doc.get('profiles', true)
  if (isSeq(node)) {
    const flow = node.flow
    const seq = doc.createNode(order)
    seq.flow = flow
    doc.set('profiles', seq)
  } else doc.set('profiles', order)
}

function isProfileFile(name: string) {
  return name.endsWith('.yaml') && !name.startsWith('.')
}
