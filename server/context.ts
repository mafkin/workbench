// A profile's context folders: context/ (identity, preferences, goals and the
// routing note), knowledge/, processes/ and inbox/, inside its notes folder.
// Set up on request, never by itself; once context/ exists, every claude chat
// gets the folders (--add-dir) and the routing note plus the context notes
// (--append-system-prompt). Handoffs and files sent to the inbox land there.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CONTEXT_FOLDERS, CONTEXT_LABEL, drawerIndex, drawersOf, expandHome, walkItems, type ContextFolder, type ContextStatus, type Op, type Profile } from '../shared/config-schema.ts'
import type { ChatContext } from './agents.ts'
import { frontmatter } from './claude-setup.ts'
import { StoreError } from './config-store.ts'
import type { Wiki } from './wiki.ts'
import { browseRoots, realish, within } from './paths.ts'
import { FolderWatcher } from './watch.ts'

/** How much of identity, preferences and goals a chat gets pasted in. */
export const CONTEXT_CAP = 16 * 1024
const CONTEXT_NOTES = ['identity.md', 'preferences.md', 'goals.md']

const DESCRIBE: Record<ContextFolder, string> = {
  context: 'who I am, my preferences and goals (below), and where things go',
  knowledge: 'reusable facts and how-tos, one topic per note',
  processes: 'workflows I repeat',
  inbox: 'handoffs and things to look at later',
}

export const STARTER: Record<string, string> = {
  'context/README.md': `# Where things go

When I ask you to remember something, or you learn something worth keeping, put it here:

| I say… | It goes to |
| --- | --- |
| "Remember how I want reports written" | \`context/preferences.md\` |
| Who I am, my role, my team | \`context/identity.md\` |
| What I'm aiming for | \`context/goals.md\` |
| A fact or how-to worth keeping ("how our deploy works") | \`knowledge/<topic>.md\` |
| A workflow I repeat ("how I cut a release") | \`processes/<name>.md\` |
| Something to look at later, a handoff | \`inbox/\` |

Keep notes short and current: change what is there rather than appending duplicates.
`,
  'context/identity.md': `# Identity

Who I am, my role and what I work on.

- Name:
- Role:
- Team:
`,
  'context/preferences.md': `# Preferences

How I like things done.

## Writing

## Code

## Reports
`,
  'context/goals.md': `# Goals

## Now

## This year
`,
}

const pad = (n: number) => String(n).padStart(2, '0')
/** A file name from a chat name: no slashes or control characters. */
const safeName = (s: string) => s.replace(/[/\\\u0000-\u001f:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat'

/** `name.ext`, else `name 2.ext`, `name 3.ext`…: written with `wx`/`COPYFILE_EXCL`, so nothing is overwritten. */
async function writeFree(dir: string, name: string, write: (file: string) => Promise<void>): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const file = path.join(dir, n === 1 ? name : `${base} ${n}${ext}`)
    try {
      await write(file)
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw err
    }
  }
}

export class Context extends EventEmitter {
  #store: Wiki
  #home: string
  /** Watched folder → the profiles it belongs to. */
  #watched = new Map<string, Set<string>>()
  #timers = new Map<string, NodeJS.Timeout>()
  #watcher: FolderWatcher

  constructor(store: Wiki, home: string) {
    super()
    this.#store = store
    this.#home = home
    const changed = (dir: string) => {
      for (const id of this.#watched.get(dir) ?? []) this.#emit(id)
    }
    this.#watcher = new FolderWatcher(64, { change: changed, replaced: changed })
  }

  close() {
    this.#watcher.close()
    for (const t of this.#timers.values()) clearTimeout(t)
  }

  #profile(id: string): Profile {
    const p = this.#store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    return p.profile
  }

  /** The notes folder, absolute; null without one. */
  #root(profile: Profile): string | null {
    return profile.notes ? path.resolve(expandHome(profile.notes, this.#home)) : null
  }

  #tilde(p: string) {
    return p === this.#home ? '~' : p.startsWith(`${this.#home}/`) ? `~${p.slice(this.#home.length)}` : p
  }

  /** Changes come in bursts (a copy, an editor's save); one event per burst. */
  #emit(id: string) {
    clearTimeout(this.#timers.get(id))
    this.#timers.set(
      id,
      setTimeout(() => {
        this.#timers.delete(id)
        this.emit('context', { profile: id })
      }, 100),
    )
  }

  #watch(id: string, dir: string) {
    if (!this.#watcher.watch(dir)) return
    const ids = this.#watched.get(dir) ?? new Set()
    ids.add(id)
    this.#watched.set(dir, ids)
  }

  async status(id: string): Promise<ContextStatus> {
    const root = this.#root(this.#profile(id))
    if (!root) return { notes: null, ready: false, folders: [], inbox: 0 }
    // The notes folder shows folders being made or removed; the inbox shows its count.
    this.#watch(id, root)
    const folders = await Promise.all(
      CONTEXT_FOLDERS.map(async (name) => {
        const dir = path.join(root, name)
        const exists = (await fsp.stat(dir).catch(() => null))?.isDirectory() ?? false
        return { name, path: this.#tilde(dir), exists }
      }),
    )
    const inboxDir = path.join(root, 'inbox')
    if (folders[3].exists) this.#watch(id, inboxDir)
    const inbox = folders[3].exists ? (await fsp.readdir(inboxDir).catch(() => [])).filter((n) => !n.startsWith('.')).length : 0
    return { notes: this.#profile(id).notes ?? null, ready: folders[0].exists, folders, inbox }
  }

  /**
   * Make the folders and starter notes that are missing (nothing is
   * overwritten), and list the folders in the nav: a Context heading at the top
   * of the first drawer's page, unless an entry already opens context/.
   */
  async setup(id: string): Promise<ContextStatus> {
    const profile = this.#profile(id)
    const root = this.#root(profile)
    if (!root) throw new StoreError('Set a notes folder first (notes: in the profile)', 409)
    for (const name of CONTEXT_FOLDERS) await fsp.mkdir(path.join(root, name), { recursive: true })
    for (const [rel, text] of Object.entries(STARTER)) {
      await fsp.writeFile(path.join(root, rel), text, { flag: 'wx' }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      })
    }
    const linked = walkItems(profile).some((e) => e.item.type === 'folder' && !!e.item.path && path.resolve(expandHome(e.item.path, this.#home)) === path.join(root, 'context'))
    if (!linked && profile.notes) {
      const notes = profile.notes
      const ops: Op[] = [
        { op: 'addSection', drawer: 0, title: 'Context', index: 0 },
        ...CONTEXT_FOLDERS.map((name, i): Op => ({ op: 'addItem', to: { drawer: 0, section: 0 }, index: i, item: { type: 'folder', label: CONTEXT_LABEL[name], path: `${notes.replace(/\/+$/, '')}/${name}` } })),
      ]
      await this.#store.apply(id, this.#store.profile(id).rev, ops)
    }
    this.#emit(id)
    return this.status(id)
  }

  /** What a claude chat gets: the folders that exist and the text to append; null until context/ exists. */
  async chatContext(id: string): Promise<ChatContext | null> {
    const profile = this.#profile(id)
    const root = this.#root(profile)
    if (!root) return null
    const dirs: string[] = []
    for (const name of CONTEXT_FOLDERS) {
      const dir = path.join(root, name)
      if ((await fsp.stat(dir).catch(() => null))?.isDirectory()) dirs.push(dir)
    }
    if (dirs[0] !== path.join(root, 'context')) return null
    const read = (file: string) => fsp.readFile(file, 'utf8').then((t) => frontmatter(t).body.trim(), () => '')
    const parts = [
      `# My context (Workbench, profile ${profile.name})`,
      ['These folders hold my context. Read them when relevant, and keep them up to date when I ask you to remember something:', ...dirs.map((d) => `- ${d}: ${DESCRIBE[path.basename(d) as ContextFolder]}`)].join('\n'),
    ]
    const routing = await read(path.join(root, 'context/README.md'))
    if (routing) parts.push(routing)
    let left = CONTEXT_CAP
    for (const name of CONTEXT_NOTES) {
      const file = path.join(root, 'context', name)
      const text = await read(file)
      if (!text) continue
      if (text.length > left) {
        parts.push(`(${file} is not included here; read it when you need it.)`)
        continue
      }
      left -= text.length
      parts.push(`## From ${name}\n\n${text}`)
    }
    return { prompt: parts.join('\n\n'), dirs }
  }

  /** Summarize and continue's summary as a note in the inbox; null when there is no inbox. */
  async saveHandoff(id: string, chatName: string, session: string | null, summary: string): Promise<string | null> {
    const root = this.#root(this.#profile(id))
    const inbox = root && path.join(root, 'inbox')
    if (!inbox || !(await fsp.stat(inbox).catch(() => null))?.isDirectory()) return null
    const d = new Date()
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
    const text = `# Handoff: ${chatName}\n\nFrom the Claude session ${session ?? '(none)'}, ${stamp.replace('.', ':')}.\n\n${summary.trim()}\n`
    const file = await writeFree(inbox, `${stamp} ${safeName(chatName)}.md`, (f) => fsp.writeFile(f, text, { flag: 'wx' }))
    return this.#tilde(file)
  }

  /** Copy a file from the profile's folders into its inbox, under a free name. */
  async sendToInbox(id: string, raw: string): Promise<{ path: string }> {
    const profile = this.#profile(id)
    const root = this.#root(profile)
    const inbox = root && path.join(root, 'inbox')
    if (!inbox || !(await fsp.stat(inbox).catch(() => null))?.isDirectory()) throw new StoreError('Set up context first: there is no inbox', 409)
    const value = raw.trim()
    if (!/^(~|\/)/.test(value)) throw new StoreError('Path must start with ~ or /', 400)
    const real = await realish(path.resolve(expandHome(value, this.#home)))
    if (!(await browseRoots(profile, this.#home)).some((r) => within(real, r.real))) throw new StoreError("Not allowed: outside this profile's folders", 403)
    const stat = await fsp.stat(real).catch(() => null)
    if (!stat) throw new StoreError('No such file', 404)
    if (!stat.isFile()) throw new StoreError('Only files can be sent to the inbox', 422)
    const file = await writeFree(inbox, path.basename(real), (f) => fsp.copyFile(real, f, fs.constants.COPYFILE_EXCL))
    this.#emit(id)
    return { path: this.#tilde(file) }
  }
}

/**
 * The shared folders a claude chat in a drawer gets: the drawer's own and
 * those of the drawers it uses, when they exist; null when there are none.
 */
export async function drawerContext(profile: Profile, drawer: number, home: string): Promise<ChatContext | null> {
  const all = drawersOf(profile)
  const own = all[drawer]
  if (!own) return null
  const named = [{ name: own.name, folder: own.folder, mine: true }]
  for (const use of own.uses ?? []) {
    const other = all[drawerIndex(profile, use)]
    if (other && other !== own) named.push({ name: other.name, folder: other.folder, mine: false })
  }
  const found: { line: string; dir: string }[] = []
  for (const d of named) {
    if (!d.folder) continue
    const dir = path.resolve(expandHome(d.folder, home))
    if (!(await fsp.stat(dir).catch(() => null))?.isDirectory() || found.some((f) => f.dir === dir)) continue
    found.push({ dir, line: `- ${dir}: ${d.mine ? `the ${d.name} drawer's own shared folder` : `shared by the ${d.name} drawer`}` })
  }
  if (!found.length) return null
  const prompt = [`# Shared folders (Workbench, drawer ${own.name})`, ['Material shared between drawers. Read it when relevant:', ...found.map((f) => f.line)].join('\n')].join('\n\n')
  return { prompt, dirs: found.map((f) => f.dir) }
}

/**
 * The wiki a claude chat gets (part 11): the profile's notes folder, where the
 * pages that configure Workbench live too, and the project's own page when the
 * chat belongs to one. Null when the folder does not exist yet.
 */
export async function wikiContext(profile: Profile, home: string, page?: string): Promise<ChatContext | null> {
  if (!profile.notes) return null
  const root = path.resolve(expandHome(profile.notes, home))
  if (!(await fsp.stat(root).catch(() => null))?.isDirectory()) return null
  const parts = [
    `# My wiki (Workbench, profile ${profile.name})`,
    [
      `${root} holds my notes and the pages that configure Workbench: index.md (the nav), projects/*.md (one per project: its frontmatter is the card, its ## Workflow the tabs), Workflow.md and agents/*.md.`,
      'Markdown there is mine; [[Name]] links name pages. Read them when relevant.',
    ].join(' '),
  ]
  if (page) {
    parts.push(
      `This project's page is ${path.join(root, page)}: its frontmatter is the card and its ## Workflow the tabs. When you finish something worth remembering, add a line under a ## Log heading there (make the heading if it is missing); leave the frontmatter and ## Workflow to me unless I ask.`,
    )
  }
  return { prompt: parts.join('\n\n'), dirs: [root] }
}

/** Two contexts as one: claude takes one --append-system-prompt and one --add-dir. */
export function mergeContext(a: ChatContext | null, b: ChatContext | null): ChatContext | null {
  if (!a || !b) return a ?? b
  return { prompt: `${a.prompt}\n\n${b.prompt}`, dirs: [...a.dirs, ...b.dirs.filter((d) => !a.dirs.includes(d))] }
}
