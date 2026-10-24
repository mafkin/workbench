// Pinned skills (part 12): `skills:` names on index.md, a drawer page and an
// item page, read as a chain; resolved against what claude loads in the chat's
// folder and the wiki's own `skills/` folder; the wiki ones reach claude as a
// per-session plugin (`--plugin-dir`), the rest are named in the prompt.
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SetupDoc } from '../shared/claude-setup.ts'
import { drawersOf, type NavItem, type Profile } from '../shared/config-schema.ts'
import { frontmatter } from './frontmatter.ts'

export interface Pinned {
  profile: string[]
  drawer: string[]
  page: string[]
  /** The chain, de-duplicated (case ignored), profile first. */
  all: string[]
}

const clean = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [])

/** The skills pinned for a chat: the profile's, the drawer's, then the page's. */
export function pinnedSkills(profile: Profile, drawer: number, item?: NavItem | null): Pinned {
  const p = clean(profile.skills)
  const d = clean(drawersOf(profile)[drawer]?.skills)
  const pg = item && item.type === 'folder' ? clean(item.skills) : []
  const all: string[] = []
  const seen = new Set<string>()
  for (const n of [...p, ...d, ...pg]) {
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    all.push(n)
  }
  return { profile: p, drawer: d, page: pg, all }
}

export interface FoundSkill {
  name: string
  description: string
  /** How claude is told to use it: `/name`, or `/wiki:name` for a wiki skill. */
  invoke: string
  /** The wiki skill's folder (absolute); installed skills have none. */
  dir?: string
}

export interface Resolved {
  found: FoundSkill[]
  missing: string[]
}

/**
 * Pinned names as skills: one in `<wiki>/skills/<name>/SKILL.md` first (the
 * user put it there for this wiki), else an installed one of that name
 * (claude loads it anyway; it is named in the prompt). The rest are missing.
 */
export async function resolveSkills(names: string[], installed: SetupDoc[], wikiRoot: string | null): Promise<Resolved> {
  const found: FoundSkill[] = []
  const missing: string[] = []
  for (const name of names) {
    const wiki = wikiRoot ? await wikiSkill(wikiRoot, name) : null
    if (wiki) {
      found.push(wiki)
      continue
    }
    const docs = installed.filter((d) => d.kind === 'skill' && d.name.toLowerCase() === name.toLowerCase())
    const doc = docs.find((d) => !d.overriddenBy) ?? docs[0]
    if (doc) found.push({ name: doc.name, description: doc.description, invoke: `/${doc.name}` })
    else missing.push(name)
  }
  return { found, missing }
}

const SKILL_NAME = /^[\w.-]+$/

async function wikiSkill(wikiRoot: string, name: string): Promise<FoundSkill | null> {
  if (!SKILL_NAME.test(name)) return null
  // The folder's own spelling wins; the pin may differ in case.
  const folders = await fsp.readdir(path.join(wikiRoot, 'skills')).catch(() => [] as string[])
  const folder = folders.find((f) => f === name) ?? folders.find((f) => f.toLowerCase() === name.toLowerCase())
  if (!folder) return null
  const dir = path.join(wikiRoot, 'skills', folder)
  const text = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null)
  if (text === null) return null
  const { data } = frontmatter(text)
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  return { name: folder, description, invoke: `/wiki:${folder}`, dir }
}

/** The wiki's skills as one list, for the rail and the card's menu. */
export async function wikiSkills(wikiRoot: string): Promise<FoundSkill[]> {
  const names = await fsp.readdir(path.join(wikiRoot, 'skills')).catch(() => [] as string[])
  const out: FoundSkill[] = []
  for (const name of names.sort()) {
    const s = await wikiSkill(wikiRoot, name)
    if (s) out.push(s)
  }
  return out
}

/** What claude is told about the pinned skills; null when none were found. */
export function skillsPrompt(found: FoundSkill[]): string | null {
  if (!found.length) return null
  const lines = found.map((s) => `- ${s.invoke}${s.description ? `: ${s.description}` : ''}`)
  return ['# Pinned skills (Workbench)', ['These skills are pinned for the work here; use them when they fit:', ...lines].join('\n')].join('\n\n')
}

/**
 * Per-session plugins holding the pinned wiki skills: `<dir>/<hash>/wiki/skills/<name>`
 * links to each skill's folder, so `--plugin-dir <dir>/<hash>/wiki` loads just
 * those, as `/wiki:<name>`. A bundle is keyed by its set, shared by chats with
 * the same pins, and kept while a saved chat names it.
 */
export class SkillBundles {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async bundle(found: FoundSkill[]): Promise<string | null> {
    const wiki = found.filter((s): s is FoundSkill & { dir: string } => !!s.dir).sort((a, b) => a.name.localeCompare(b.name))
    if (!wiki.length) return null
    const hash = createHash('sha1')
      .update(wiki.map((s) => `${s.name}\n${s.dir}`).join('\n'))
      .digest('hex')
      .slice(0, 16)
    const plugin = path.join(this.dir, hash, 'wiki')
    await fsp.mkdir(path.join(plugin, 'skills'), { recursive: true })
    await fsp.mkdir(path.join(plugin, '.claude-plugin'), { recursive: true })
    await fsp.writeFile(path.join(plugin, '.claude-plugin/plugin.json'), `${JSON.stringify({ name: 'wiki', description: 'Skills pinned in Workbench pages' }, null, 2)}\n`)
    for (const s of wiki) {
      const link = path.join(plugin, 'skills', s.name)
      const current = await fsp.readlink(link).catch(() => null)
      if (current === s.dir) continue
      await fsp.rm(link, { recursive: true, force: true })
      await fsp.symlink(s.dir, link, 'dir')
    }
    return plugin
  }

  /** Remove the bundles no chat names any more (`keep` holds `--plugin-dir` values). */
  async prune(keep: Iterable<string>): Promise<void> {
    const wanted = new Set([...keep].map((p) => path.resolve(p)))
    const hashes = await fsp.readdir(this.dir).catch(() => [] as string[])
    for (const h of hashes) {
      const plugin = path.join(this.dir, h, 'wiki')
      if (!wanted.has(plugin)) await fsp.rm(path.join(this.dir, h), { recursive: true, force: true })
    }
  }
}

/** The `--plugin-dir` values in a chat's args. */
export function pluginDirsIn(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--plugin-dir') out.push(args[i + 1])
  return out
}
