// A YAML profile as pages (part 11): `index.md` with the profile and the nav
// (or the drawer list), `drawers/*.md`, one page per project under
// `projects/`, `Workflow.md` and `agents/*.md`. Pure: it returns the files to
// write; the store writes them, never over a page that exists. The seed uses
// it too, so a first run starts with pages.
import { Document } from 'yaml'
import {
  AGENT_FIELDS,
  CARD_FIELDS,
  drawersOf,
  entryAt,
  expandHome,
  hasDrawers,
  legacySteps,
  noteFileName,
  type NavItem,
  type Profile,
  type Section,
  type StepItem,
} from '../shared/config-schema.ts'
import { parseProfile } from './config-store.ts'
import * as md from './wiki-md.ts'

export interface Migrated {
  /** The wiki folder, as written (`~/…`). */
  wiki: string
  /** Files inside it. */
  files: Record<string, string>
}

export interface MigrateOptions {
  id: string
  home: string
  /** Whether a folder is inside a git repository (an old project without `steps:` then gets a Git tab); none = no. */
  repo?: (folder: string) => boolean
  /** The wiki folder to use instead of the profile's `notes:` (or `<home>/notes`). */
  wiki?: string
}

/** Where a profile's wiki goes: its notes folder, else `<home>/notes`, else `~/notes`. */
export function defaultWiki(profile: Pick<Profile, 'notes' | 'home'>): string {
  return profile.notes ?? (profile.home && profile.home !== '~' ? `${profile.home.replace(/\/+$/, '')}/notes` : '~/notes')
}

/** The frontmatter block for `data` (keys with undefined or null left out), or '' when nothing is left. */
export function metaBlock(data: Record<string, unknown>): string {
  const kept = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)))
  if (!Object.keys(kept).length) return ''
  return `---\n${new Document(kept).toString().replace(/\n$/, '')}\n---\n`
}

export function migrateProfile(text: string, opts: MigrateOptions): Migrated {
  const { profile, error } = parseProfile(text)
  if (!profile) throw new Error(error?.message ?? 'The profile does not parse')
  return migrateParsed(profile, opts)
}

export function migrateParsed(profile: Profile, opts: MigrateOptions): Migrated {
  const wiki = opts.wiki ?? defaultWiki(profile)
  const files: Record<string, string> = {}
  const taken = new Set<string>()
  const free = (dir: string, name: string) => {
    const file = noteFileName(name) ?? 'Page.md'
    let rel = `${dir}/${file}`
    for (let n = 2; taken.has(rel.toLowerCase()); n++) rel = `${dir}/${file.replace(/\.md$/, ` ${n}.md`)}`
    taken.add(rel.toLowerCase())
    return rel
  }
  const names = new Map<string, number>()
  const count = (rel: string) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '').toLowerCase()
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  // Pages for every project, made first so links can name them.
  const pageOf = new Map<NavItem, string>()
  const walk = (items: NavItem[], f: (item: NavItem) => void) => {
    for (const it of items) {
      f(it)
      if (it.type === 'group') walk(it.items, f)
    }
  }
  const drawers = drawersOf(profile)
  for (const d of drawers) for (const s of d.sections) walk(s.items, (it) => it.type === 'folder' && pageOf.set(it, free('projects', it.label)))
  for (const rel of pageOf.values()) count(rel)
  for (const d of drawers) if (hasDrawers(profile)) count(`drawers/${noteFileName(d.name)}`)
  for (const name of Object.keys(profile.agents ?? {})) count(`agents/${noteFileName(name)}`)
  const linkTo = (rel: string) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '')
    return (names.get(name.toLowerCase()) ?? 0) > 1 ? rel.replace(/\.md$/, '') : name
  }
  const ctx = { wiki, linkTo }

  for (const [item, rel] of pageOf) {
    if (item.type !== 'folder') continue
    // A folderless item keeps its id: chats and saved tabs are keyed by it.
    const meta: Record<string, unknown> = { folder: item.path, id: item.path ? undefined : item.id, icon: item.icon }
    for (const f of CARD_FIELDS) meta[f] = (item as Record<string, unknown>)[f]
    if (meta.status === 'active') meta.status = undefined
    if (meta.pinned === false) meta.pinned = undefined
    meta.servers = item.servers
    const steps = item.steps ?? legacySteps(profile, !!item.path && !!opts.repo?.(expandHome(item.path, opts.home)))
    const body = `# ${item.label}\n${item.description ? `\n${item.description}\n` : ''}${steps.length ? `\n## Workflow\n\n${steps.map((s) => `- ${md.linkOf(s, ctx, true)}`).join('\n')}\n` : ''}`
    files[rel] = metaBlock(meta) + body
  }

  const line = (item: NavItem): string => {
    if (item.type === 'shared') {
      const original = entryAt(profile, { drawer: 0, section: 0, index: 0 }) && findOriginal(profile, item)
      return original ? line(original) : `${item.label} (shared from ${item.drawer}, not found)`
    }
    const rel = pageOf.get(item)
    if (rel) return md.linkOf({ ...item, page: rel } as NavItem, ctx)
    if (item.type === 'group') return item.label
    return md.linkOf(item, ctx)
  }
  const navText = (sections: Section[]) =>
    sections
      .map((s) => `## ${s.title}\n${s.items.length ? '\n' : ''}${s.items.map((it) => [`- ${line(it)}`, ...(it.type === 'group' ? it.items.map((c) => `  - ${line(c)}`) : [])].join('\n')).join('\n')}${s.items.length ? '\n' : ''}`)
      .join('\n')

  const indexMeta: Record<string, unknown> = {
    name: profile.name,
    accent: profile.accent,
    theme: profile.theme,
    background: profile.background,
    home: profile.home,
    categories: profile.categories,
    openWith: profile.openWith,
    mcpOff: profile.mcpOff,
  }
  if (hasDrawers(profile)) {
    const rels = drawers.map((d) => free('drawers', d.name))
    drawers.forEach((d, i) => {
      files[rels[i]] = metaBlock({ logo: d.logo, folder: d.folder, uses: d.uses }) + navText(d.sections)
    })
    files['index.md'] = `${metaBlock(indexMeta)}## Drawers\n\n${rels.map((r) => `- [[${r.replace(/\.md$/, '')}]]`).join('\n')}\n`
  } else {
    files['index.md'] = metaBlock(indexMeta) + navText(profile.sections)
  }
  if (profile.workflow.length) {
    files['Workflow.md'] = `# Workflow\n\nThe steps an item gets with Add profile steps; Save as profile steps writes them here.\n\n${profile.workflow.map((s: StepItem) => `- ${md.linkOf(s, ctx, true)}`).join('\n')}\n`
  }
  for (const [name, a] of Object.entries(profile.agents ?? {})) {
    const meta: Record<string, unknown> = {}
    for (const f of AGENT_FIELDS) if (f !== 'instructions') meta[f] = (a as Record<string, unknown>)[f]
    files[free('agents', name)] = metaBlock(meta) + (a.instructions?.trim() ? `${a.instructions.trim()}\n` : '')
  }
  return { wiki, files }
}

/** The entry a shared entry stands for, by its drawer and label (and path). */
function findOriginal(profile: Profile, ref: Extract<NavItem, { type: 'shared' }>): NavItem | null {
  const drawers = drawersOf(profile)
  const d = drawers.findIndex((x) => x.name.toLowerCase() === ref.drawer.toLowerCase())
  if (d < 0) return null
  const all: NavItem[] = []
  for (const s of drawers[d].sections) for (const it of s.items) all.push(it, ...(it.type === 'group' ? it.items : []))
  return all.find((it) => it.type !== 'shared' && it.type !== 'group' && it.label === ref.label && (ref.path === undefined || ('path' in it && it.path === ref.path))) ?? null
}
