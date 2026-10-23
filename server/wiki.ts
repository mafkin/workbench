// Profiles as wikis (part 11). `settings.yaml` names each profile's wiki
// folder; inside it, `index.md` holds the profile (frontmatter) and the nav
// (or the list of drawer pages), `drawers/*.md` the drawers, item pages their
// card and `## Workflow`, `Workflow.md` the profile steps and `agents/*.md`
// the agent profiles. The pages are the source of truth: hand edits are
// picked up by watchers, app edits touch only the lines they must, and a
// page that will not parse is reported and never written. The in-memory
// shape is the same `Profile` the YAML gave, so the rest of the app is
// unchanged. Profiles still in YAML are read, read-only, until migrated.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import {
  AgentProfile,
  AGENT_FIELDS,
  ACCENTS,
  displayPath,
  drawersOf,
  expandHome,
  getItem,
  NavItem as NavItemSchema,
  noteFileName,
  NOTE_EXT,
  Profile,
  PROFILE_ID,
  PROFILE_ID_RULE,
  StepItem as StepItemSchema,
  walkItems,
  type AppState,
  type ConfigError,
  type ItemAddr,
  type ItemInput,
  type NavItem,
  type Op,
  type Profile as ProfileT,
  type ProfileState,
  type Section,
  type StepItem,
} from '../shared/config-schema.ts'
import { describeIssue } from './config-ops.ts'
import { parseProfile, StoreError } from './config-store.ts'
import { revOf, writeAtomic } from './fs-util.ts'
import { defaultWiki, migrateProfile } from './migrate.ts'
import { absPath, realish } from './paths.ts'
import { FolderWatcher } from './watch.ts'
import * as md from './wiki-md.ts'
import { PageError, type LinkContext, type PageRef } from './wiki-md.ts'

export { StoreError }

const MAX_PAGES = 5000
const MAX_DEPTH = 8
const MAX_WATCHED = 24

/** `settings.yaml`: profiles as a map of id to wiki folder, or the older list of ids (YAML profiles in `profiles/`). */
const SettingsFile = z.object({
  activeProfile: z.string().optional(),
  profiles: z.union([z.record(z.string(), z.string()), z.array(z.string())]).nullish(),
})

/** The keys of `index.md`'s frontmatter the profile is read from (besides categories, openWith and mcpOff). */
const INDEX_META = ['name', 'accent', 'theme', 'background', 'home'] as const

interface Entry extends ProfileState {
  /** The wiki folder, absolute, for pages; `~/…` form in `wiki`. */
  root: string
  /** Every file the profile was read from, with the text it had. */
  files: Map<string, string>
  /** What the files held before the last app edit (null = did not exist). */
  undo?: { files: Map<string, string | null>; revAfter: string }
}

/** A page of the wiki by its path inside it. */
interface Known {
  rel: string
  name: string
}

/** The result of reading a wiki: what the profile needs, plus how the pages map onto it. */
interface View {
  profile: ProfileT | null
  error: ConfigError | null
  problems: string[]
  files: Map<string, string>
  /** The page each drawer's nav lives in (index.md without drawer pages), absolute. */
  navFiles: string[]
  /** Every page by its lower-cased path without extension, and by name. */
  pages: Map<string, Known>
  byName: Map<string, Known[]>
  refs: Map<string, PageRef>
  /** The page a wiki link names. */
  known: (target: string) => Known | null
}

type Reader = (abs: string) => Promise<string | null>
type Folder = Extract<NavItem, { type: 'folder' }>

const lower = (s: string) => s.toLowerCase()
const noExt = (rel: string) => rel.replace(NOTE_EXT, '')
const nameOf = (rel: string) => noExt(rel.slice(rel.lastIndexOf('/') + 1))

export class Wiki extends EventEmitter {
  readonly dir: string
  readonly settingsFile: string
  readonly home: string
  #entries = new Map<string, Entry>()
  #settings: { activeProfile?: string; profiles: Record<string, string>; legacy: string[] } = { profiles: {}, legacy: [] }
  #settingsText = ''
  #settingsWatcher: fs.FSWatcher | null = null
  #folders = new FolderWatcher(MAX_WATCHED, { change: (dir) => this.#touched(dir), replaced: (dir) => this.#touched(dir) })
  #watching = false
  #timers = new Map<string, NodeJS.Timeout>()
  #queue: Promise<unknown> = Promise.resolve()
  #ready = false

  constructor(dir: string, home: string) {
    super()
    this.dir = dir
    this.home = home
    this.settingsFile = path.join(dir, 'settings.yaml')
  }

  async init({ seed = true, watch = true } = {}) {
    await fsp.mkdir(this.dir, { recursive: true })
    await this.#loadSettings()
    if (seed && !Object.keys(this.#settings.profiles).length && !this.#settings.legacy.length) {
      const { seedWiki } = await import('./seed.ts')
      await seedWiki(this.dir, this.home)
      await this.#loadSettings()
    }
    this.#watching = watch
    for (const id of Object.keys(this.#settings.profiles)) await this.#load(id)
    for (const id of this.#settings.legacy) await this.#loadLegacy(id)
    if (watch) this.#watchSettings()
    this.#ready = true
  }

  close() {
    this.#settingsWatcher?.close()
    this.#folders.close()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#timers.clear()
  }

  /** Everything but `home`, which the server adds. */
  state(): Omit<AppState, 'home'> {
    const order = [...Object.keys(this.#settings.profiles), ...this.#settings.legacy].filter((id) => this.#entries.has(id))
    const active = this.#settings.activeProfile && this.#entries.has(this.#settings.activeProfile) ? this.#settings.activeProfile : (order[0] ?? '')
    return { activeProfile: active, profiles: order.map((id) => this.#public(this.#entries.get(id)!)) }
  }

  profile(id: string): ProfileState {
    const e = this.#entries.get(id)
    if (!e) throw new StoreError(`No profile "${id}"`, 404)
    return this.#public(e)
  }

  /** The text of a page of the profile's wiki, as last read (index.md by default). */
  text(id: string, rel = 'index.md'): string {
    const e = this.#entry(id)
    return e.files.get(path.join(e.root, rel)) ?? ''
  }

  /** Whether any profile is still a YAML file. */
  get legacy(): boolean {
    return this.#settings.legacy.length > 0
  }

  /** Apply edits made in the UI. `rev` is the revision the UI last saw. */
  apply(id: string, rev: string, ops: Op[]): Promise<{ rev: string }> {
    return this.#serial(async () => {
      const e = await this.#current(id, rev)
      const draft = new Draft(e)
      let view = await this.#read(e, draft.read)
      for (const op of ops) {
        try {
          await this.#applyOp(e, view, draft, op)
        } catch (err) {
          if (err instanceof PageError || err instanceof OpError) throw new StoreError(err.message, 400)
          throw err
        }
        view = await this.#read(e, draft.read)
        if (view.error) throw new StoreError(`${op.op} would break the profile: ${view.error.message}`, 400)
      }
      await this.#commit(e, draft, true)
      return { rev: e.rev }
    })
  }

  /** Restore the files from before the last app edit. */
  undo(id: string, rev: string): Promise<{ rev: string }> {
    return this.#serial(async () => {
      const e = await this.#current(id, rev)
      if (!e.undo || e.undo.revAfter !== e.rev) throw new StoreError('Nothing to undo', 409)
      const draft = new Draft(e)
      for (const [abs, text] of e.undo.files) draft.put(abs, text)
      await this.#commit(e, draft, false)
      return { rev: e.rev }
    })
  }

  setActive(id: string): Promise<void> {
    return this.#serial(async () => {
      this.#entry(id)
      await this.#editSettings((doc) => doc.set('activeProfile', id))
      this.emit('change')
    })
  }

  /**
   * A new profile: a wiki folder (made if missing; its index.md never overwritten)
   * with a name and an unused accent, or a copy of another profile's index.md
   * (its nav and look) and Workflow.md. Last in the switcher.
   */
  createProfile(id: string, opts: { name: string; wiki: string; copyFrom?: string }): Promise<void> {
    return this.#serial(async () => {
      if (!PROFILE_ID.test(id)) throw new StoreError(PROFILE_ID_RULE, 400)
      if (this.#entries.has(id)) throw new StoreError(`There is already a profile "${id}"`, 409)
      const root = absPath(opts.wiki, this.home)
      for (const e of this.#entries.values()) {
        if (e.root === root) throw new StoreError(`${opts.wiki} is already ${e.id}'s wiki`, 409)
        if (root.startsWith(`${e.root}${path.sep}`)) throw new StoreError(`${opts.wiki} is inside ${e.id}'s wiki (${e.wiki}); pick a folder of its own`, 409)
        if (e.root.startsWith(`${root}${path.sep}`)) throw new StoreError(`${opts.wiki} holds ${e.id}'s wiki (${e.wiki}); pick a folder of its own`, 409)
      }
      const index = path.join(root, 'index.md')
      await fsp.mkdir(root, { recursive: true })
      if (!(await exists(index))) {
        let text: string
        let workflow: string | null = null
        if (opts.copyFrom) {
          const src = this.#entry(opts.copyFrom)
          if (!src.profile) throw new StoreError('That profile is broken', 423)
          text = md.setMeta(src.files.get(path.join(src.root, 'index.md')) ?? '', 'name', opts.name)
          workflow = src.files.get(path.join(src.root, 'Workflow.md')) ?? null
        } else {
          const used = [...this.#entries.values()].map((e) => e.profile?.accent)
          const accent = ACCENTS.find((a) => !used.includes(a)) ?? ACCENTS[0]
          text = `---\nname: ${JSON.stringify(opts.name)}\naccent: "${accent}"\n---\n## Start\n`
        }
        await writeAtomic(index, text)
        if (workflow !== null) await fsp.writeFile(path.join(root, 'Workflow.md'), workflow, { flag: 'wx' }).catch(() => {})
      }
      await this.#editSettings((doc) => setProfiles(doc, { ...this.#settings.profiles, [id]: displayPath(root, this.home) }))
      await this.#load(id)
      this.emit('change')
    })
  }

  /** Forget a profile: it leaves the switcher; its wiki stays on disk. The last one stays. */
  removeProfile(id: string): Promise<void> {
    return this.#serial(async () => {
      this.#entry(id)
      if (this.#entries.size <= 1) throw new StoreError('The last profile cannot be removed', 409)
      const { [id]: _gone, ...rest } = this.#settings.profiles
      const state = this.state()
      await this.#editSettings((doc) => {
        setProfiles(doc, rest)
        if (state.activeProfile === id) doc.set('activeProfile', state.profiles.find((p) => p.id !== id)!.id)
      })
      this.#entries.delete(id)
      this.emit('change')
    })
  }

  /** Move every YAML profile to pages (see migrate.ts); the YAML files are kept as `.bak`. */
  migrate(): Promise<{ moved: string[] }> {
    return this.#serial(async () => {
      const moved: string[] = []
      const profiles = { ...this.#settings.profiles }
      for (const id of [...this.#settings.legacy]) {
        const e = this.#entries.get(id)
        if (!e) continue
        if (!e.profile) throw new StoreError(`${id}.yaml has an error; fix it first`, 423)
        const text = e.files.get(e.file) ?? ''
        // A profile without a notes folder gets ~/notes, or ~/notes-<id> when another wiki is there or inside it.
        const taken = Object.values(profiles).map((w) => absPath(w, this.home))
        const clash = (w: string) => taken.some((t) => t === w || t.startsWith(`${w}${path.sep}`) || w.startsWith(`${t}${path.sep}`))
        let wiki = defaultWiki(e.profile)
        if (!e.profile.notes && clash(absPath(wiki, this.home))) wiki = `~/notes-${id}`
        const out = migrateProfile(text, { id, home: this.home, wiki, repo: (folder) => inRepo(folder) })
        const root = absPath(out.wiki, this.home)
        if (taken.includes(root)) throw new StoreError(`${id} and another profile would share ${out.wiki}`, 409)
        for (const [rel, content] of Object.entries(out.files)) {
          const abs = path.join(root, rel)
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          // Never over a page the wiki already has.
          await fsp.writeFile(abs, content, { flag: 'wx' }).catch((err) => {
            if (err.code !== 'EEXIST') throw err
          })
        }
        await fsp.rename(e.file, `${e.file}.bak`)
        profiles[id] = out.wiki
        moved.push(id)
      }
      await this.#editSettings((doc) => setProfiles(doc, profiles))
      await this.#loadSettings()
      for (const id of moved) {
        this.#entries.delete(id)
        await this.#load(id)
      }
      this.emit('change')
      return { moved }
    })
  }

  // Reading

  #public(e: Entry): ProfileState {
    const { root: _root, files: _files, undo: _undo, ...state } = e
    return state
  }

  #entry(id: string): Entry {
    const e = this.#entries.get(id)
    if (!e) throw new StoreError(`No profile "${id}"`, 404)
    return e
  }

  async #load(id: string) {
    const wiki = this.#settings.profiles[id]
    if (!wiki) return
    let root: string
    try {
      root = await realish(absPath(wiki, this.home))
    } catch {
      root = absPath(wiki, this.home)
    }
    const e: Entry = this.#entries.get(id) ?? { id, file: path.join(root, 'index.md'), rev: '', profile: null, error: null, wiki, root, files: new Map() }
    e.root = root
    e.wiki = wiki
    e.file = path.join(root, 'index.md')
    const before = e.rev
    const view = await this.#read(e, readDisk)
    this.#take(e, view)
    this.#entries.set(id, e)
    if (this.#watching) this.#watch(e)
    if (this.#ready && e.rev !== before) this.emit('change')
  }

  #take(e: Entry, view: View) {
    e.files = view.files
    e.rev = revOf([...view.files].map(([p, t]) => `${p}\n${revOf(t)}`).join('\n'))
    e.error = view.error
    e.problems = view.problems.length ? view.problems : undefined
    if (view.profile) e.profile = view.profile
  }

  /** The profile from its pages, read through `read` (disk, or a draft on top of it). */
  async #read(e: Entry, read: Reader): Promise<View> {
    const files = new Map<string, string>()
    const problems: string[] = []
    const want = async (rel: string) => {
      const abs = path.join(e.root, rel)
      const text = await read(abs)
      if (text !== null) files.set(abs, text)
      return text
    }
    const fail = (message: string, line?: number): View => ({ profile: null, error: { message, line }, problems, files, navFiles: [], pages: new Map(), byName: new Map(), refs: new Map(), known: () => null })

    const indexText = await want('index.md')
    if (indexText === null) return fail('index.md is missing; make it to give this profile a name')
    const index = md.parsePage(indexText)
    if (index.metaError) return fail(`index.md: ${index.metaError}`, 1)

    const { pages, byName } = await this.#collect(e.root, read)
    const refs = new Map<string, PageRef>()
    const known = (target: string): Known | null => {
      const t = lower(target.trim().replace(/^\/+/, '').replace(NOTE_EXT, ''))
      if (!t) return null
      if (t.includes('/')) return pages.get(t) ?? null
      const list = byName.get(t) ?? []
      // A name matches the page in projects/ first, then the root, then the shortest path.
      return [...list].sort((a, b) => rank(a.rel) - rank(b.rel) || a.rel.length - b.rel.length)[0] ?? null
    }
    const linkTo = (rel: string) => {
      const name = nameOf(rel)
      const same = byName.get(lower(name)) ?? []
      return same.length === 1 && known(name)?.rel === rel ? name : noExt(rel)
    }
    const ctxFor = (self: string): LinkContext => ({
      wiki: e.wiki!,
      self,
      page: (target) => {
        const k = known(target)
        return k ? (refs.get(k.rel) ?? { rel: k.rel, name: k.name, meta: {}, steps: [], problems: [] }) : null
      },
      linkTo,
    })
    const display = (rel: string) => displayPath(path.join(e.root, rel), this.home)

    /** Read and parse a page linked from the nav: its frontmatter and `## Workflow`. */
    const loadRef = async (k: Known) => {
      if (refs.has(k.rel)) return
      const text = await want(k.rel)
      if (text === null) return
      const page = md.parsePage(text)
      const ref: PageRef = { rel: k.rel, name: k.name, meta: page.meta, metaError: page.metaError, steps: [], problems: [] }
      refs.set(k.rel, ref)
      const wf = md.sectionNamed(page, 'Workflow')
      if (wf !== null) {
        const ctx = ctxFor(display(k.rel))
        for (const item of page.sections[wf].items) {
          const r = md.stepOf(item, ctx)
          ref.steps.push(r.step)
          if (r.problem) problems.push(`${k.rel}: ${r.problem}`)
        }
      }
    }
    const targetsOf = (page: md.Page) => {
      const out: string[] = []
      const visit = (items: md.PageItem[]) => {
        for (const it of items) {
          if (it.link.kind === 'wiki') out.push(it.link.target)
          visit(it.children)
        }
      }
      visit(page.lead)
      for (const s of page.sections) visit(s.items)
      return out
    }
    /** A nav page's headings as sections, pages it links loaded first. */
    const sectionsOf = async (page: md.Page, rel: string): Promise<Section[]> => {
      for (const t of targetsOf(page)) {
        const k = known(t)
        if (k) await loadRef(k)
      }
      const ctx = ctxFor(display(rel))
      for (const it of page.lead) problems.push(`${rel}: "${md.pageLabel === undefined ? '' : ''}${lineLabel(it)}" is above the first heading; put entries under a ## heading`)
      return page.sections.map((s) => ({
        title: s.title,
        items: s.items.map((it) => {
          const r = md.navItemOf(it, ctx)
          if (r.problem) problems.push(`${rel}: ${r.problem}`)
          return r.item
        }),
      }))
    }

    // Drawers: index.md links to pages under drawers/; else its own headings are the one drawer.
    const drawerLinks: Known[] = []
    for (const t of targetsOf(index)) {
      const k = known(t)
      if (k && lower(k.rel).startsWith('drawers/') && !drawerLinks.some((d) => d.rel === k.rel)) drawerLinks.push(k)
    }
    const navFiles: string[] = []
    let drawers: ProfileT['drawers']
    let sections: Section[] = []
    if (drawerLinks.length) {
      drawers = []
      for (const d of drawerLinks) {
        const text = await want(d.rel)
        if (text === null) continue
        const page = md.parsePage(text)
        if (page.metaError) return fail(`${d.rel}: ${page.metaError}`, 1)
        const m = page.meta
        drawers.push({
          name: d.name,
          ...(typeof m.logo === 'string' ? { logo: m.logo } : {}),
          ...(typeof m.folder === 'string' ? { folder: m.folder } : {}),
          ...(Array.isArray(m.uses) ? { uses: m.uses.map(String) } : {}),
          sections: await sectionsOf(page, d.rel),
        })
        navFiles.push(path.join(e.root, d.rel))
      }
      const isDrawer = (it: md.PageItem) => it.link.kind === 'wiki' && drawerLinks.some((d) => d.rel === known((it.link as { target: string }).target)?.rel)
      const others = index.sections.flatMap((s) => s.items).filter((it) => !isDrawer(it))
      for (const it of others) problems.push(`index.md: "${lineLabel(it)}" is listed with the drawers; put it in a drawer page`)
    } else {
      sections = await sectionsOf(index, 'index.md')
      navFiles.push(e.file)
    }

    // Workflow.md: the profile steps, as a template.
    const workflow: StepItem[] = []
    const wfText = await want('Workflow.md')
    if (wfText !== null) {
      const page = md.parsePage(wfText)
      const named = md.sectionNamed(page, 'Workflow')
      const items = page.lead.length ? page.lead : named !== null ? page.sections[named].items : (page.sections[0]?.items ?? [])
      const ctx = ctxFor(display('Workflow.md'))
      for (const it of items) {
        const r = md.stepOf(it, ctx)
        workflow.push(r.step)
        if (r.problem) problems.push(`Workflow.md: ${r.problem}`)
      }
    }

    // agents/*.md: frontmatter plus the body as instructions.
    const agents: Record<string, unknown> = {}
    for (const k of [...pages.values()].filter((k) => lower(k.rel).startsWith('agents/') && !k.rel.slice(7).includes('/'))) {
      const text = await want(k.rel)
      if (text === null) continue
      const page = md.parsePage(text)
      if (page.metaError) {
        problems.push(`${k.rel}: ${page.metaError}`)
        continue
      }
      const body = text.slice(page.lines.slice(0, page.body).join('\n').length + (page.body ? 1 : 0)).trim()
      const a: Record<string, unknown> = {}
      for (const f of AGENT_FIELDS) if (f !== 'instructions' && page.meta[f] !== undefined) a[f] = page.meta[f]
      if (body) a.instructions = body
      agents[k.name] = a
    }

    const meta = index.meta
    const data: Record<string, unknown> = { notes: e.wiki, workflow, sections, ...(drawers ? { drawers } : {}) }
    for (const key of INDEX_META) if (meta[key] !== undefined && meta[key] !== null) data[key] = meta[key]
    if (data.name === undefined) data.name = e.id
    for (const key of ['categories', 'openWith', 'mcpOff'] as const) if (meta[key] !== undefined && meta[key] !== null) data[key] = meta[key]
    if (Object.keys(agents).length) data.agents = agents
    const parsed = Profile.safeParse(data)
    if (!parsed.success) return { ...fail(`index.md: ${describeIssue(parsed.error)}`), navFiles, pages, byName, refs, known }
    return { profile: parsed.data, error: null, problems, files, navFiles, pages, byName, refs, known }
  }

  /** Every Markdown file of the wiki (dot folders, node_modules and symlinks skipped). */
  async #collect(root: string, read: Reader): Promise<Pick<View, 'pages' | 'byName'>> {
    const pages = new Map<string, Known>()
    const byName = new Map<string, Known[]>()
    const add = (rel: string) => {
      const k: Known = { rel, name: nameOf(rel) }
      pages.set(lower(noExt(rel)), k)
      const list = byName.get(lower(k.name)) ?? []
      list.push(k)
      byName.set(lower(k.name), list)
    }
    const walk = async (dir: string, rel: string, depth: number) => {
      const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const d of list) {
        if (pages.size >= MAX_PAGES) return
        if (d.name.startsWith('.') || d.name === 'node_modules' || d.isSymbolicLink()) continue
        const childRel = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory() && depth < MAX_DEPTH) await walk(path.join(dir, d.name), childRel, depth + 1)
        else if (d.isFile() && NOTE_EXT.test(d.name)) add(childRel)
      }
    }
    await walk(root, '', 0)
    // Pages a draft made but has not written yet.
    for (const rel of (read as Reader & { created?: () => string[] }).created?.() ?? []) if (!pages.has(lower(noExt(rel)))) add(rel)
    return { pages, byName }
  }

  async #loadLegacy(id: string) {
    const file = path.join(this.dir, 'profiles', `${id}.yaml`)
    const text = await fsp.readFile(file, 'utf8').catch(() => null)
    if (text === null) {
      if (this.#entries.delete(id) && this.#ready) this.emit('change')
      return
    }
    const e = this.#entries.get(id)
    if (e && e.files.get(file) === text) return
    const { profile, error } = parseProfile(text)
    const entry: Entry = e ?? { id, file, rev: '', profile: null, error: null, root: '', files: new Map() }
    entry.legacy = true
    entry.files = new Map([[file, text]])
    entry.rev = revOf(text)
    entry.error = error
    if (profile) entry.profile = profile
    this.#entries.set(id, entry)
    if (this.#ready) this.emit('change')
  }

  // Watching

  #watch(e: Entry) {
    const dirs = new Set([e.root, ...['drawers', 'projects', 'agents'].map((d) => path.join(e.root, d)), ...[...e.files.keys()].map((f) => path.dirname(f))])
    for (const d of dirs) this.#folders.watch(d)
  }

  #touched(dir: string) {
    for (const e of this.#entries.values()) {
      if (e.legacy || !(dir === e.root || dir.startsWith(`${e.root}${path.sep}`))) continue
      clearTimeout(this.#timers.get(e.id))
      this.#timers.set(
        e.id,
        setTimeout(() => {
          this.#timers.delete(e.id)
          this.#serial(() => this.#load(e.id)).catch((err) => this.emit('error', err))
        }, 60),
      )
    }
  }

  #watchSettings() {
    try {
      this.#settingsWatcher = fs.watch(this.dir, (_event, name) => {
        if (name !== 'settings.yaml') return
        clearTimeout(this.#timers.get('settings'))
        this.#timers.set(
          'settings',
          setTimeout(() => {
            this.#timers.delete('settings')
            this.#serial(async () => {
              if (!(await this.#loadSettings())) return
              // A profile that was just moved to pages is loaded afresh.
              for (const id of Object.keys(this.#settings.profiles)) {
                if (this.#entries.get(id)?.legacy) this.#entries.delete(id)
                if (!this.#entries.has(id)) await this.#load(id)
              }
              for (const id of [...this.#entries.keys()]) if (!(id in this.#settings.profiles) && !this.#settings.legacy.includes(id)) this.#entries.delete(id)
              this.emit('change')
            }).catch((err) => this.emit('error', err))
          }, 60),
        )
      })
    } catch {
      // No config folder to watch yet.
    }
  }

  // Settings

  async #loadSettings(): Promise<boolean> {
    const text = await fsp.readFile(this.settingsFile, 'utf8').catch(() => '')
    if (text === this.#settingsText && text) return false
    this.#settingsText = text
    const parsed = SettingsFile.safeParse(parseDocument(text || '{}').toJS() ?? {})
    const s = parsed.success ? parsed.data : { profiles: undefined, activeProfile: undefined }
    const profiles: Record<string, string> = {}
    let legacy: string[] = []
    if (Array.isArray(s.profiles)) legacy = s.profiles.filter((id) => PROFILE_ID.test(id))
    else for (const [id, wiki] of Object.entries(s.profiles ?? {})) if (PROFILE_ID.test(id) && typeof wiki === 'string') profiles[id] = wiki
    // YAML profiles not listed are still profiles, as before.
    if (!Object.keys(profiles).length) {
      const dir = path.join(this.dir, 'profiles')
      const found = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.yaml') && !f.startsWith('.')).map((f) => f.slice(0, -5))
      for (const id of found.sort()) if (!legacy.includes(id)) legacy.push(id)
    }
    this.#settings = { activeProfile: s.activeProfile, profiles, legacy }
    return true
  }

  async #editSettings(edit: (doc: ReturnType<typeof parseDocument>) => void) {
    const doc = parseDocument(this.#settingsText || '{}')
    if (doc.errors.length) throw new StoreError('settings.yaml has an error; fix it first', 423)
    edit(doc)
    const text = doc.toString()
    await writeAtomic(this.settingsFile, text)
    this.#settingsText = ''
    await this.#loadSettings()
  }

  // Applying ops

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn)
    this.#queue = run.catch(() => {})
    return run
  }

  /** The entry, checked against the UI's revision and against the files on disk. */
  async #current(id: string, rev: string): Promise<Entry> {
    const e = this.#entry(id)
    if (e.legacy) throw new StoreError(`${id} is still a YAML profile; move it to pages first`, 423)
    // The watchers may not have caught up with a hand edit yet.
    let changed = false
    for (const [abs, text] of e.files) if ((await readDisk(abs)) !== text) changed = true
    if (changed) {
      this.#take(e, await this.#read(e, readDisk))
      e.undo = undefined
      this.emit('change')
    }
    if (e.error) throw new StoreError(`${path.relative(e.root, e.file)} has an error${e.error.line ? ` on line ${e.error.line}` : ''}; fix it first`, 423)
    if (rev !== e.rev) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    return e
  }

  async #commit(e: Entry, draft: Draft, keepUndo: boolean) {
    const before = new Map<string, string | null>()
    for (const [abs, text] of draft.changes()) {
      before.set(abs, e.files.get(abs) ?? (await readDisk(abs)))
      if (text === null) await fsp.rm(abs, { force: true })
      else {
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await writeAtomic(abs, text)
      }
    }
    this.#take(e, await this.#read(e, readDisk))
    e.undo = keepUndo ? { files: before, revAfter: e.rev } : undefined
    if (this.#watching) this.#watch(e)
    this.emit('change')
  }

  async #applyOp(e: Entry, view: View, draft: Draft, op: Op) {
    const profile = view.profile!
    const root = e.root
    const nav = (drawer: number | undefined) => {
      const file = view.navFiles[drawer ?? 0]
      if (!file) throw new OpError(`Drawer ${drawer} does not exist`)
      return file
    }
    const text = (abs: string) => draft.get(abs) ?? ''
    const setNav = (drawer: number | undefined, fn: (t: string) => string) => {
      const file = nav(drawer)
      draft.put(file, fn(text(file)))
    }
    const linkCtx = { wiki: e.wiki!, linkTo: (rel: string) => this.#linkTo(view, rel) }
    const index = path.join(root, 'index.md')
    const freeRel = (dir: string, name: string) => {
      const file = noteFileName(name) ?? 'Page.md'
      let rel = `${dir}/${file}`
      for (let n = 2; view.pages.has(lower(noExt(rel))) || draft.has(path.join(root, rel)); n++) rel = `${dir}/${file.replace(/\.md$/, ` ${n}.md`)}`
      return rel
    }
    /** A link to a page made in this batch: its name when no other page has it, else its path. */
    const newLink = (rel: string, label: string) => {
      const name = nameOf(rel)
      const to = (view.byName.get(lower(name))?.length ?? 0) > 0 ? noExt(rel) : name
      view.pages.set(lower(noExt(rel)), { rel, name })
      view.byName.set(lower(name), [...(view.byName.get(lower(name)) ?? []), { rel, name }])
      return name === label ? `[[${to}]]` : `[[${to}|${label}]]`
    }
    /** The item at `at` as a page: made in projects/ from a folder link when it has none. */
    const pageOf = (at: ItemAddr): { item: Folder & { page: string }; abs: string } => {
      const item = getItem(profile, at)
      if (!item) throw new OpError('No such entry')
      if (item.type !== 'folder') throw new OpError('Only pages have a card and tabs; this entry is a link')
      if (item.page) return { item: item as Folder & { page: string }, abs: path.join(root, item.page) }
      const rel = freeRel('projects', item.label)
      const body = `# ${item.label}\n\n## Workflow\n\n${(item.steps ?? []).map((s) => `- ${md.linkOf(s, linkCtx, true)}`).join('\n')}\n`
      draft.create(path.join(root, rel), md.setMetas(body, { folder: item.path, icon: item.icon }))
      setNav(at.drawer, (t) => md.replaceLink(t, at.section, at.group, at.index, newLink(rel, item.label)))
      return { item: { ...item, page: rel }, abs: path.join(root, rel) }
    }
    /** The `## Workflow` heading of a page, added at its end when missing. */
    const workflowOf = (abs: string): number => {
      let page = md.parsePage(text(abs))
      let i = md.sectionNamed(page, 'Workflow')
      if (i === null) {
        draft.put(abs, md.addSection(text(abs), 'Workflow'))
        page = md.parsePage(text(abs))
        i = md.sectionNamed(page, 'Workflow')!
      }
      return i
    }
    const stepLink = (input: ItemInput) => md.linkOf(parseStep(input), linkCtx, true)
    /**
     * The drawer pages, making the first one when the profile has none yet:
     * index.md's own nav moves into a page named after the profile, and
     * index.md lists it under `## Drawers`. Returns each drawer's page.
     */
    const ownDrawers = (): string[] => {
      if (profile.drawers?.length) return view.navFiles
      const first = freeRel('drawers', profile.name)
      const indexText = text(index)
      const page = md.parsePage(indexText)
      const body = page.lines.slice(page.body).join('\n')
      const abs = path.join(root, first)
      draft.create(abs, body.trim() ? body.replace(/\n*$/, '\n') : `## ${profile.name}\n`)
      draft.put(index, `${page.lines.slice(0, page.body).join('\n')}${page.body ? '\n' : ''}## Drawers\n\n- [[${noExt(first)}]]\n`)
      view.navFiles = [abs]
      return view.navFiles
    }

    switch (op.op) {
      case 'addSection':
        setNav(op.drawer, (t) => md.addSection(t, heading(op.title), op.index))
        return
      case 'renameSection':
        setNav(op.drawer, (t) => md.renameSection(t, op.section, heading(op.title)))
        return
      case 'deleteSection':
        setNav(op.drawer, (t) => md.deleteSection(t, op.section))
        return
      case 'moveSection':
        setNav(op.drawer, (t) => md.moveSection(t, op.from, op.to))
        return
      case 'addItem': {
        if (op.to.group !== undefined && op.item.type === 'group') throw new OpError('A group cannot contain another group')
        let link: string
        if (op.item.type === 'item') {
          const input = op.item as { label: string; path?: string; icon?: string; steps?: ItemInput[] }
          const rel = freeRel('projects', input.label)
          const steps = (input.steps ?? []).map((s) => `- ${stepLink(s)}`)
          const body = `# ${input.label}\n${steps.length ? `\n## Workflow\n\n${steps.join('\n')}\n` : ''}`
          draft.create(path.join(root, rel), md.setMetas(body, { folder: input.path, icon: input.icon }))
          link = newLink(rel, input.label)
        } else link = md.linkOf(parseNav(op.item), linkCtx)
        setNav(op.to.drawer, (t) => md.insertItem(t, op.to.section, op.to.group, op.index, link))
        return
      }
      case 'updateItem': {
        if (op.at.group !== undefined && op.item.type === 'group') throw new OpError('A group cannot contain another group')
        const existing = getItem(profile, op.at)
        if (!existing) throw new OpError('No such entry')
        if (existing.type === 'folder' && existing.page) {
          const input = op.item as { label?: string; path?: string; icon?: string; type?: string }
          if (input.type && input.type !== 'folder' && input.type !== 'item') throw new OpError('A page stays a page; link something else beside it')
          const abs = path.join(root, existing.page)
          draft.put(abs, md.setMetas(text(abs), { folder: input.path?.trim() || null, icon: input.icon?.trim() || null }))
          const label = input.label?.trim() || existing.label
          const to = this.#linkTo(view, existing.page)
          setNav(op.at.drawer, (t) => md.replaceLink(t, op.at.section, op.at.group, op.at.index, nameOf(to) === label ? `[[${to}]]` : `[[${to}|${label}]]`))
          return
        }
        if (existing.type === 'group' && op.item.type === 'group') {
          const label = String((op.item as { label?: string }).label ?? '').trim()
          if (!label) throw new OpError('Label is required')
          setNav(op.at.drawer, (t) => md.replaceLink(t, op.at.section, op.at.group, op.at.index, label))
          return
        }
        if (op.item.type === 'item') throw new OpError('Add a new item instead; a link cannot become a page here')
        setNav(op.at.drawer, (t) => md.replaceLink(t, op.at.section, op.at.group, op.at.index, md.linkOf(parseNav(op.item), linkCtx)))
        return
      }
      case 'deleteItem':
        setNav(op.at.drawer, (t) => md.removeItem(t, op.at.section, op.at.group, op.at.index))
        return
      case 'moveItem':
        if ((op.from.drawer ?? 0) !== (op.to.drawer ?? 0)) throw new OpError('Entries stay in their drawer; use Show in <drawer> instead')
        setNav(op.from.drawer, (t) => md.moveItem(t, op.from, { section: op.to.section, group: op.to.group, index: op.index }))
        return
      case 'setProfileField': {
        if (op.key === 'notes') throw new OpError('The notes folder is the wiki itself; move the folder to change it')
        draft.put(index, md.setMeta(text(index), op.key, op.value.trim() || null))
        return
      }
      case 'setCategory': {
        const categories = { ...(profile.categories ?? {}) }
        if (op.color) categories[op.name] = op.color
        else delete categories[op.name]
        draft.put(index, md.setMeta(text(index), 'categories', Object.keys(categories).length ? categories : null))
        return
      }
      case 'setMcpOff': {
        const set = new Set(profile.mcpOff ?? [])
        for (const n of op.names) op.off ? set.add(n) : set.delete(n)
        draft.put(index, md.setMeta(text(index), 'mcpOff', set.size ? [...set] : null))
        return
      }
      case 'setCard': {
        const { abs } = pageOf(op.at)
        const value = op.value === null || op.value === '' || (op.field === 'status' && op.value === 'active') || (op.field === 'pinned' && op.value === false) ? null : op.value
        draft.put(abs, md.setMeta(text(abs), op.field, value))
        return
      }
      case 'addStep': {
        const { abs } = pageOf(op.at)
        if (op.folder) draft.put(abs, md.setMeta(text(abs), 'folder', op.folder))
        const link = stepLink(op.step)
        const s = workflowOf(abs)
        draft.put(abs, md.insertItem(text(abs), s, undefined, op.index, link))
        return
      }
      case 'updateStep': {
        const { abs } = pageOf(op.at)
        const s = workflowOf(abs)
        draft.put(abs, md.replaceLink(text(abs), s, undefined, op.index, stepLink(op.step)))
        return
      }
      case 'deleteStep': {
        const { abs } = pageOf(op.at)
        const s = workflowOf(abs)
        draft.put(abs, md.removeItem(text(abs), s, undefined, op.index))
        return
      }
      case 'moveStep': {
        const { abs } = pageOf(op.at)
        const s = workflowOf(abs)
        draft.put(abs, md.moveItem(text(abs), { section: s, index: op.from }, { section: s, index: op.to }))
        return
      }
      case 'addWorkflow': {
        const { item, abs } = pageOf(op.at)
        const have = new Set((item.steps ?? []).map((s) => `${s.type}\n${s.label}`))
        for (const step of profile.workflow) {
          if (have.has(`${step.type}\n${step.label}`)) continue
          const s = workflowOf(abs)
          draft.put(abs, md.insertItem(text(abs), s, undefined, undefined, md.linkOf(step, linkCtx, true)))
        }
        return
      }
      case 'setWorkflow': {
        const { item } = pageOf(op.at)
        const abs = path.join(root, 'Workflow.md')
        const list = (item.steps ?? []).map((s) => `- ${md.linkOf(s, linkCtx, true)}`).join('\n')
        const existing = draft.get(abs)
        if (existing === null) draft.put(abs, `# Workflow\n\nThe steps a new item gets with Add profile steps.\n\n${list}\n`)
        else {
          // Replace the file's list, keeping its prose.
          const page = md.parsePage(existing)
          const items = page.lead.length ? page.lead : (page.sections[0]?.items ?? [])
          const lines = page.lines
          if (items.length) lines.splice(items[0].line, items[items.length - 1].end - items[0].line, ...list.split('\n'))
          else lines.push(...list.split('\n'), '')
          draft.put(abs, lines.join('\n'))
        }
        return
      }
      case 'setAgent':
        this.#setAgent(e, view, draft, op.name, op.agent, op.rename)
        return
      case 'addDrawer': {
        const name = heading(op.name)
        const drawers = drawersOf(profile)
        if (drawers.some((d) => lower(d.name) === lower(name))) throw new OpError(`There is already a drawer called ${name}`)
        ownDrawers()
        const rel = freeRel('drawers', name)
        draft.create(path.join(root, rel), `# ${name}\n`)
        const indexText = text(index)
        const page = md.parsePage(indexText)
        const section = page.sections.findIndex((s) => s.items.some((it) => it.link.kind === 'wiki' && lower(it.link.target).startsWith('drawers/')))
        draft.put(index, md.insertItem(indexText, section < 0 ? null : section, undefined, undefined, `[[${noExt(rel)}]]`))
        return
      }
      case 'setDrawer': {
        const d = drawersOf(profile)[op.drawer]
        if (!d) throw new OpError(`Drawer ${op.drawer} does not exist`)
        const abs = ownDrawers()[op.drawer]
        if (op.field === 'name') {
          const name = heading(String(op.value))
          if (drawersOf(profile).some((x, i) => i !== op.drawer && lower(x.name) === lower(name))) throw new OpError(`There is already a drawer called ${name}`)
          const rel = freeRel('drawers', name)
          draft.move(abs, path.join(root, rel))
          const page = md.parsePage(text(index))
          page.sections.forEach((s, si) =>
            s.items.forEach((it, ii) => {
              if (it.link.kind === 'wiki' && view.known(it.link.target)?.rel === path.relative(root, abs)) draft.put(index, md.replaceLink(text(index), si, undefined, ii, `[[${noExt(rel)}]]`))
            }),
          )
          // Drawers using this one's folder name it.
          for (const [i, other] of drawersOf(profile).entries()) {
            if (i === op.drawer || !other.uses?.some((u) => lower(u) === lower(d.name))) continue
            const f = view.navFiles[i]
            draft.put(f, md.setMeta(text(f), 'uses', other.uses!.map((u) => (lower(u) === lower(d.name) ? name : u))))
          }
          return
        }
        const value = Array.isArray(op.value) ? (op.value.length ? op.value : null) : op.value.trim() || null
        draft.put(abs, md.setMeta(text(abs), op.field, value))
        return
      }
      case 'deleteDrawer': {
        if (!profile.drawers?.length) throw new OpError('This profile has no drawers')
        if (profile.drawers.length <= 1) throw new OpError('The last drawer stays')
        const abs = view.navFiles[op.drawer]
        if (!abs) throw new OpError(`Drawer ${op.drawer} does not exist`)
        const rel = path.relative(root, abs)
        const page = md.parsePage(text(index))
        for (let si = page.sections.length - 1; si >= 0; si--) {
          const s = page.sections[si]
          for (let ii = s.items.length - 1; ii >= 0; ii--) {
            const it = s.items[ii]
            if (it.link.kind === 'wiki' && view.known(it.link.target)?.rel === rel) draft.put(index, md.removeItem(text(index), si, undefined, ii))
          }
        }
        return
      }
      case 'setShared': {
        const item = getItem(profile, op.at)
        if (!item || item.type !== 'folder' || !item.page) throw new OpError('Only pages can be shown in other drawers')
        const target = view.navFiles[op.drawer]
        if (!target) throw new OpError(`Drawer ${op.drawer} does not exist`)
        if (target === nav(op.at.drawer)) throw new OpError('That is this entry’s own drawer')
        const rel = item.page
        const page = md.parsePage(text(target))
        const linked = (it: md.PageItem) => it.link.kind === 'wiki' && view.known(it.link.target)?.rel === rel
        if (op.on) {
          if (page.sections.some((s) => s.items.some(linked))) return
          const title = drawersOf(profile)[op.at.drawer ?? 0]?.sections[op.at.section]?.title ?? 'Shared'
          let t = text(target)
          let si = md.sectionNamed(page, title)
          if (si === null) {
            t = md.addSection(t, title)
            si = md.sectionNamed(md.parsePage(t), title)!
          }
          draft.put(target, md.insertItem(t, si, undefined, undefined, md.linkOf(item, linkCtx)))
        } else {
          for (let si = page.sections.length - 1; si >= 0; si--) {
            const s = page.sections[si]
            for (let ii = s.items.length - 1; ii >= 0; ii--) if (linked(s.items[ii])) draft.put(target, md.removeItem(text(target), si, undefined, ii))
          }
        }
        return
      }
    }
  }

  /** Create, update, rename or delete `agents/<name>.md`; a delete is refused while something names the agent. */
  #setAgent(e: Entry, view: View, draft: Draft, name: string, input: unknown, rename?: string) {
    const profile = view.profile!
    const existing = Object.keys(profile.agents ?? {}).find((n) => lower(n) === lower(name.trim()))
    const fileOf = (n: string) => path.join(e.root, 'agents', `${noteFileName(n)}`)
    if (input === null) {
      if (!existing) throw new OpError(`No agent profile named ${name}`)
      const users = agentUsers(profile, existing)
      if (users.length) throw new OpError(`${existing} is used by ${users.join(', ')}; pick another agent there first`)
      draft.put(fileOf(existing), null)
      return
    }
    // An empty field from the editor means "not set".
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (v.trim()) cleaned[k] = v
      } else if (Array.isArray(v)) {
        const items = v.filter((x) => typeof x !== 'string' || x.trim())
        if (items.length) cleaned[k] = items
      } else if (v !== undefined && v !== null) cleaned[k] = v
    }
    const parsed = AgentProfile.safeParse(cleaned)
    if (!parsed.success) throw new OpError(describeIssue(parsed.error))
    const a = parsed.data
    const newName = (rename ?? existing ?? name).trim()
    if (!noteFileName(newName)) throw new OpError('An agent profile needs a name')
    if (rename && Object.keys(profile.agents ?? {}).some((n) => lower(n) === lower(rename) && n !== existing)) throw new OpError(`There is already an agent profile named ${rename}`)
    const abs = existing ? fileOf(existing) : fileOf(newName)
    let text = draft.get(abs) ?? ''
    const meta: Record<string, unknown> = {}
    for (const f of AGENT_FIELDS) {
      if (f === 'instructions') continue
      const v = (a as Record<string, unknown>)[f]
      meta[f] = v === undefined || (Array.isArray(v) && !v.length) ? null : v
    }
    const page = md.parsePage(text)
    const head = page.lines.slice(0, page.body).join('\n')
    text = `${head}${page.body ? '\n' : ''}${(a.instructions ?? '').trim()}${a.instructions?.trim() ? '\n' : ''}`
    text = md.setMetas(text, meta)
    if (existing) draft.put(abs, text)
    else draft.create(abs, text)
    if (existing && rename && lower(rename) !== lower(existing)) {
      draft.move(abs, fileOf(rename))
      this.#renameAgentUses(e, view, draft, existing, rename)
    } else if (existing && rename && rename !== existing) draft.move(abs, fileOf(rename))
  }

  /** Point every `chat:` link and `agent:` field at an agent's new name. */
  #renameAgentUses(e: Entry, view: View, draft: Draft, from: string, to: string) {
    const profile = view.profile!
    const linkCtx = { wiki: e.wiki!, linkTo: (rel: string) => this.#linkTo(view, rel) }
    const same = (n: string | undefined) => n !== undefined && lower(n) === lower(from)
    for (const { addr, item } of walkItems(profile)) {
      const file = view.navFiles[addr.drawer ?? 0]
      if (item.type === 'chat' && same(item.agent)) draft.put(file, md.replaceLink(draft.get(file) ?? '', addr.section, addr.group, addr.index, md.linkOf({ ...item, agent: to }, linkCtx)))
      if (item.type === 'folder' && item.page) {
        const abs = path.join(e.root, item.page)
        if (same(item.agent)) draft.put(abs, md.setMeta(draft.get(abs) ?? '', 'agent', to))
        const page = md.parsePage(draft.get(abs) ?? '')
        const wf = md.sectionNamed(page, 'Workflow')
        if (wf !== null) {
          ;(item.steps ?? []).forEach((s, i) => {
            if (s.type === 'chat' && same(s.agent)) draft.put(abs, md.replaceLink(draft.get(abs) ?? '', wf, undefined, i, md.linkOf({ ...s, agent: to }, linkCtx, true)))
          })
        }
      }
    }
    const wfFile = path.join(e.root, 'Workflow.md')
    const wfText = draft.get(wfFile)
    if (wfText !== null) {
      const page = md.parsePage(wfText)
      const items = page.lead.length ? page.lead : (page.sections[0]?.items ?? [])
      const lines = page.lines
      profile.workflow.forEach((s, i) => {
        const it = items[i]
        if (!it || s.type !== 'chat' || !same(s.agent)) return
        lines[it.line] = lines[it.line].slice(0, it.span[0]) + md.linkOf({ ...s, agent: to }, linkCtx, true) + lines[it.line].slice(it.span[1])
      })
      draft.put(wfFile, lines.join('\n'))
    }
  }

  #linkTo(view: View, rel: string): string {
    const name = nameOf(rel)
    const same = view.byName.get(lower(name)) ?? []
    return same.length <= 1 ? name : noExt(rel)
  }
}

/** Where the entries naming an agent are, for the message that refuses to delete it. */
function agentUsers(profile: ProfileT, name: string): string[] {
  const out: string[] = []
  const same = (n: string | undefined) => n !== undefined && lower(n) === lower(name)
  for (const [i, s] of profile.workflow.entries()) if (s.type === 'chat' && same(s.agent)) out.push(`Workflow.md › ${s.label || i}`)
  for (const { item } of walkItems(profile)) {
    if (item.type === 'chat' && same(item.agent)) out.push(item.label)
    if (item.type === 'folder') {
      if (same(item.agent)) out.push(item.label)
      for (const s of item.steps ?? []) if (s.type === 'chat' && same(s.agent)) out.push(`${item.label} › ${s.label}`)
    }
  }
  return out
}

/** Pages in projects/ first, then the wiki's root, then anything else. */
const rank = (rel: string) => (lower(rel).startsWith('projects/') ? 0 : rel.includes('/') ? 2 : 1)

const lineLabel = (it: md.PageItem) => (it.link.kind === 'wiki' ? (it.link.alias ?? it.link.target) : it.link.label)

export class OpError extends Error {}

function heading(value: string): string {
  const t = value.trim()
  if (!t) throw new OpError('Heading title is required')
  if (t.includes('\n')) throw new OpError('A heading is one line')
  return t
}

/** A nav entry from the UI's input, validated and with defaults filled in. */
function parseNav(input: ItemInput): NavItem {
  const r = NavItemSchema.safeParse(input)
  if (!r.success) throw new OpError(describeIssue(r.error))
  if (r.data.type === 'shared') throw new OpError('A shared entry is the page itself, linked from both drawers')
  return r.data
}

function parseStep(input: ItemInput): StepItem {
  const r = StepItemSchema.safeParse(input)
  if (!r.success) throw new OpError(describeIssue(r.error))
  return r.data
}

const exists = (p: string) => fsp.access(p).then(() => true, () => false)

/** Whether a folder is inside a git repository (a `.git` here or above). */
function inRepo(folder: string): boolean {
  let dir = folder
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

const readDisk: Reader = (abs) =>
  fsp.readFile(abs, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null
    throw err
  })

/** The files an op batch changes, over the files as read; nothing is written until commit. */
class Draft {
  #base: Map<string, string>
  #root: string
  #changes = new Map<string, string | null>()
  readonly read: Reader & { created: () => string[] }

  constructor(e: Entry) {
    this.#base = e.files
    this.#root = e.root
    const read: Reader = async (abs) => (this.#changes.has(abs) ? this.#changes.get(abs)! : (this.#base.get(abs) ?? (await readDisk(abs))))
    this.read = Object.assign(read, {
      created: () => [...this.#changes].filter(([abs, t]) => t !== null && !this.#base.has(abs)).map(([abs]) => path.relative(this.#root, abs)),
    })
  }

  /** The current text of a file, from the draft, the last read, or null when there is none. */
  get(abs: string): string | null {
    if (this.#changes.has(abs)) return this.#changes.get(abs)!
    const base = this.#base.get(abs)
    if (base !== undefined) return base
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch {
      return null
    }
  }

  has(abs: string): boolean {
    return this.get(abs) !== null
  }

  put(abs: string, text: string | null) {
    this.#changes.set(abs, text)
  }

  create(abs: string, text: string) {
    if (this.has(abs)) throw new OpError(`${path.basename(abs)} already exists`)
    this.put(abs, text)
  }

  move(from: string, to: string) {
    if (from === to) return
    if (this.has(to)) throw new OpError(`${path.basename(to)} already exists`)
    const text = this.get(from)
    if (text === null) throw new OpError(`${path.basename(from)} does not exist`)
    this.put(to, text)
    this.put(from, null)
  }

  changes(): [string, string | null][] {
    return [...this.#changes].filter(([abs, text]) => text !== (this.#base.get(abs) ?? null) || (text === null && this.#base.has(abs)))
  }
}

/** The `profiles:` map in settings.yaml, as `id: ~/wiki` lines. */
function setProfiles(doc: ReturnType<typeof parseDocument>, profiles: Record<string, string>) {
  doc.set('profiles', doc.createNode(profiles))
}

export { expandHome }
