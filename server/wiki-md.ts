// The pages that configure a profile, as text: `index.md` and drawer pages
// (headings and link lists are the nav), item pages (`## Workflow` is the
// tabs), `Workflow.md` (the profile steps). Everything here works on strings
// and lines, so edits touch only the lines they must and prose around a list
// is kept byte for byte. Nothing here reads files.
import { Document, isMap, isScalar, parseDocument } from 'yaml'
import { NOTE_EXT, type NavItem, type StepItem } from '../shared/config-schema.ts'
import { FRONTMATTER, parseWiki } from '../shared/wikilinks.ts'
import { frontmatter, type Json } from './frontmatter.ts'

export class PageError extends Error {}

type LaunchItem = Extract<StepItem, { type: 'launch' }>
type ChatItem = Extract<StepItem, { type: 'chat' }>
type DailyItem = Extract<NavItem, { type: 'daily' }>

// Parsing

/** What a list item links to: a page, a Markdown link, or plain text (a group in the nav). */
export type ParsedLink =
  | { kind: 'wiki'; target: string; alias?: string; heading?: string }
  | { kind: 'md'; label: string; dest: string; title?: string }
  | { kind: 'text'; label: string }

export interface PageItem {
  /** 0-based line of the item; `end` is the line after its last line (children included, trailing blanks excluded). */
  line: number
  end: number
  indent: number
  link: ParsedLink
  /** Offsets of the link (or the text) in its line. */
  span: [number, number]
  children: PageItem[]
}

export interface PageSection {
  title: string
  /** The heading's line; `end` is the line after the section's last line. */
  line: number
  end: number
  items: PageItem[]
}

export interface Page {
  meta: Json
  metaError?: string
  /** The first line after the frontmatter. */
  body: number
  /** List items before the first heading (Workflow.md has its list there). */
  lead: PageItem[]
  sections: PageSection[]
  lines: string[]
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/
const FENCE = /^\s*(```|~~~)/
const WIKI_AT_START = /^\[\[([^[\]\n]+?)\]\]/
// The destination may be in <angle brackets>, which CommonMark needs when it has spaces (`<run:godot --path .>`).
const MD_AT_START = /^!?\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\((<[^<>\n]*>|[^()\s<>]+)(?:\s+"([^"\n]*)")?\)/

export function parseLink(text: string): { link: ParsedLink; span: [number, number] } {
  const lead = text.length - text.trimStart().length
  const t = text.slice(lead)
  const wiki = WIKI_AT_START.exec(t)
  if (wiki) {
    const { target, heading, label } = parseWiki(wiki[1])
    const alias = wiki[1].includes('|') ? label : undefined
    return { link: { kind: 'wiki', target, alias, heading }, span: [lead, lead + wiki[0].length] }
  }
  const md = MD_AT_START.exec(t)
  if (md) {
    const dest = md[2].startsWith('<') ? md[2].slice(1, -1).trim() : md[2]
    return { link: { kind: 'md', label: md[1].trim(), dest, title: md[3] || undefined }, span: [lead, lead + md[0].length] }
  }
  const label = t.trim()
  return { link: { kind: 'text', label }, span: [lead, lead + label.length] }
}

/** Lines of a page as headings, lists and frontmatter; code fences are skipped. */
export function parsePage(text: string): Page {
  const lines = text.split('\n')
  const fm = frontmatter(text)
  const m = FRONTMATTER.exec(text)
  const body = m ? m[0].split('\n').length - 1 : 0
  const page: Page = { meta: fm.data, metaError: fm.error, body, lead: [], sections: [], lines }
  let section: PageSection | null = null
  let items = page.lead
  let fence: string | null = null
  // The item each indent currently continues, deepest last.
  let open: PageItem[] = []
  const closeItems = (upTo: number) => {
    for (const it of open) it.end = Math.max(it.end, trimEnd(lines, it.line, upTo))
    open = []
  }
  for (let i = body; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE.exec(line)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1] === fence) fence = null
      continue
    }
    if (fence) continue
    const h = HEADING.exec(line)
    if (h) {
      closeItems(i)
      if (section) section.end = trimEnd(lines, section.line, i)
      if (h[1].length === 2) {
        section = { title: h[2], line: i, end: i + 1, items: [] }
        page.sections.push(section)
        items = section.items
      } else {
        // A # or ### heading ends the nav heading; a list after it is a lead list (Workflow.md has a title).
        section = null
        items = page.lead
      }
      continue
    }
    const li = LIST_ITEM.exec(line)
    if (li) {
      const indent = li[1].length
      const { link, span } = parseLink(li[2])
      const offset = line.length - li[2].length
      const item: PageItem = { line: i, end: i + 1, indent, link, span: [span[0] + offset, span[1] + offset], children: [] }
      // Close deeper or equal items; a deeper one becomes a child of the open parent.
      while (open.length && open[open.length - 1].indent >= indent) open.pop()!.end = trimEnd(lines, 0, i)
      const parent = open[open.length - 1]
      if (parent) {
        if (parent.indent === 0 && open.length === 1) parent.children.push(item)
        // Deeper than one level: kept in the parent's block, not an entry of its own.
      } else items.push(item)
      open.push(item)
      continue
    }
    if (line.trim() === '') continue
    // Text at or left of an open item's indent ends it; deeper text continues it.
    const indent = line.length - line.trimStart().length
    while (open.length && indent <= open[open.length - 1].indent) open.pop()!.end = trimEnd(lines, 0, i)
  }
  closeItems(lines.length)
  if (section) section.end = trimEnd(lines, section.line, lines.length)
  fixEnds(page.lead)
  for (const s of page.sections) fixEnds(s.items)
  return page
}

/** The line after the last non-blank line before `upTo`, never before `from` + 1. */
function trimEnd(lines: string[], from: number, upTo: number): number {
  let end = upTo
  while (end > from + 1 && lines[end - 1].trim() === '') end--
  return end
}

/** An item ends no earlier than its children. */
function fixEnds(items: PageItem[]) {
  for (const it of items) {
    for (const c of it.children) it.end = Math.max(it.end, c.end)
  }
}

// Targets

export type TargetKind = 'link' | 'run' | 'chat' | 'daily' | 'files' | 'git' | 'setup' | 'folder' | 'note' | 'report' | 'file'

const SCHEME = /^([a-z][a-z0-9+.-]*):(.*)$/is
const OVERRIDES = new Set(['folder', 'note', 'report', 'file'])

/** What a Markdown link's destination opens as, from its shape. */
export function targetKind(dest: string): { kind: TargetKind; rest: string } {
  const m = SCHEME.exec(dest)
  if (m) {
    const scheme = m[1].toLowerCase()
    if (scheme === 'http' || scheme === 'https') return { kind: 'link', rest: dest }
    if (scheme === 'run' || scheme === 'chat' || scheme === 'daily' || scheme === 'files' || scheme === 'git' || scheme === 'setup') return { kind: scheme, rest: m[2].trim() }
    if (OVERRIDES.has(scheme)) return { kind: scheme as TargetKind, rest: m[2].trim() }
    return { kind: 'link', rest: dest }
  }
  const p = dest.replace(/#.*$/, '')
  if (p.endsWith('/') || p === '~' || p === '.' || p === '..') return { kind: 'folder', rest: p }
  const last = p.slice(p.lastIndexOf('/') + 1)
  if (NOTE_EXT.test(last)) return { kind: 'note', rest: p }
  if (/\.html?$/i.test(last)) return { kind: 'report', rest: p }
  if (!last.includes('.') || last === '.' || last === '..') return { kind: 'folder', rest: p }
  return { kind: 'file', rest: p }
}

/** Split a command line like a shell would: whitespace, '…' and "…" (with \" inside), no expansion. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (quote === '"' && c === '\\' && i + 1 < line.length && '"\\'.includes(line[i + 1])) cur += line[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else cur += c
  }
  if (quote) throw new PageError('A quote is not closed')
  if (has || cur) out.push(cur)
  return out
}

/** The inverse of splitCommand: words with spaces or quotes are quoted. */
export function joinCommand(args: string[]): string {
  return args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ')
}

/** `cd <dir> && <command>` (or `;`): a launcher with its own working folder. */
const CD = /^cd\s+(\S+)\s*(?:&&|;)\s*(.+)$/s

export function parseRun(rest: string): Pick<LaunchItem, 'command' | 'args' | 'cwd'> {
  const cd = CD.exec(rest)
  const words = splitCommand(cd ? cd[2] : rest)
  if (!words.length) throw new PageError('run: needs a command')
  return { command: words[0], args: words.slice(1), ...(cd ? { cwd: cd[1] } : {}) }
}

export function renderRun(l: Pick<LaunchItem, 'command' | 'args' | 'cwd'>): string {
  const line = joinCommand([l.command, ...(l.args ?? [])])
  return `run:${l.cwd ? `cd ${l.cwd} && ` : ''}${line}`
}

const looksLikePath = (w: string) => w.startsWith('~') || w.startsWith('/') || w.startsWith('.') || w.includes('/')

/** `chat:[agent] [folder] [-- args]`: an agent name, a folder (by its shape) and arguments after `--` or the first `-x`. */
export function parseChat(rest: string): Pick<ChatItem, 'agent' | 'path' | 'args'> {
  const words = splitCommand(rest)
  let agent: string | undefined
  let path: string | undefined
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i]
    if (w.startsWith('-')) break
    if (looksLikePath(w)) {
      if (path !== undefined) throw new PageError(`chat: names two folders (${path}, ${w})`)
      path = w.length > 1 ? w.replace(/\/+$/, '') || '/' : w
    } else {
      if (agent !== undefined) throw new PageError(`chat: names two agents (${agent}, ${w})`)
      agent = w
    }
  }
  const args = words.slice(i)
  if (args[0] === '--') args.shift()
  return { agent, path, args }
}

export function renderChat(c: Pick<ChatItem, 'agent' | 'path' | 'args'>): string {
  // A bare folder name (`src`) gets a slash, so it reads as a folder and not as an agent.
  const folder = c.path ? (looksLikePath(c.path) ? c.path : `${c.path}/`) : undefined
  const words = [...(c.agent ? [c.agent] : []), ...(folder ? [folder] : []), ...(c.args?.length ? ['--', ...c.args] : [])]
  return `chat:${joinCommand(words)}`
}

export function parseDaily(rest: string): Pick<DailyItem, 'folder' | 'template'> {
  const [folder, template] = splitCommand(rest)
  return { ...(folder ? { folder } : {}), ...(template ? { template } : {}) }
}

export const renderDaily = (d: Pick<DailyItem, 'folder' | 'template'>) => `daily:${joinCommand([...(d.folder ? [d.folder] : []), ...(d.template ? [d.template] : [])])}`.replace(/:$/, ':')

// Items from links and back

/** A page the wiki knows, as the nav needs it. */
export interface PageRef {
  /** Path inside the wiki, with extension. */
  rel: string
  name: string
  meta: Json
  metaError?: string
  /** The page's `## Workflow` as steps (empty without one). */
  steps: StepItem[]
  /** Problems in its Workflow list. */
  problems: string[]
}

export interface LinkContext {
  /** The wiki folder as written in the config (`~/notes`). */
  wiki: string
  /** The page being read, as a `~/…` path: a line that cannot be an entry opens it, so it can be fixed. */
  self: string
  /** The page a wiki link names, or null. */
  page: (target: string) => PageRef | null
  /** The shortest unambiguous way to write a link to a page: its name, else its path. */
  linkTo: (rel: string) => string
}

/** The card and step fields a page's frontmatter may carry. */
const PAGE_FIELDS = ['description', 'status', 'category', 'pinned', 'agent', 'servers', 'icon'] as const

export const pageLabel = (link: Extract<ParsedLink, { kind: 'wiki' }>, page: PageRef | null) => link.alias ?? page?.name ?? link.target.slice(link.target.lastIndexOf('/') + 1)

/** A line that cannot be what its list needs: a note that opens the page itself, where it can be fixed. */
const broken = (label: string, ctx: LinkContext) => ({ type: 'note' as const, label, path: ctx.self, icon: 'triangle-alert' })

/**
 * A nav entry from a list item. A line that gives none still takes its place
 * (as a note opening the page), so addresses match the file; `problem` says why.
 */
export function navItemOf(item: PageItem, ctx: LinkContext): { item: NavItem; problem?: string } {
  const r = navItemRaw(item, ctx)
  return r.item ? { item: r.item, problem: r.problem } : { item: broken(labelOf(item.link), ctx), problem: r.problem }
}

const labelOf = (link: ParsedLink) => (link.kind === 'wiki' ? (link.alias ?? link.target) : link.label)

function navItemRaw(item: PageItem, ctx: LinkContext): { item: NavItem | null; problem?: string } {
  const { link } = item
  if (link.kind === 'text') {
    const children: Exclude<NavItem, { type: 'group' }>[] = []
    for (const c of item.children) {
      const child = navItemOf(c, ctx).item
      children.push(child.type === 'group' ? broken(child.label, ctx) : child)
    }
    return { item: { type: 'group', label: link.label, items: children } }
  }
  if (link.kind === 'wiki') {
    const page = ctx.page(link.target)
    const label = pageLabel(link, page)
    const file = `${ctx.wiki}/${page?.rel ?? pageFile(link.target)}`
    // A page that is missing, or whose frontmatter is broken, opens as a note: there it can be made or fixed.
    if (!page || page.metaError) return { item: { type: 'note', label, path: file }, problem: page?.metaError ? `${page.rel}: ${page.metaError}` : undefined }
    const meta = page.meta
    const folder = typeof meta.folder === 'string' && meta.folder.trim() ? meta.folder.trim() : undefined
    const fields: Record<string, unknown> = {}
    for (const k of PAGE_FIELDS) if (meta[k] !== undefined && meta[k] !== null) fields[k] = meta[k]
    // Without a folder the page's id keys its chats: its own `id:` when it has one, else the page itself.
    const id = typeof meta.id === 'string' && meta.id.trim() ? meta.id.trim() : `page:${page.rel}`
    return { item: { type: 'folder', label, ...fields, ...(folder ? { path: folder } : { id }), page: page.rel, steps: page.steps } as NavItem }
  }
  const { kind, rest } = targetKind(link.dest)
  const base = { label: link.label || rest, ...(link.title ? { icon: link.title } : {}) }
  try {
    switch (kind) {
      case 'link':
        return { item: { ...base, type: 'link', url: rest } }
      case 'run':
        return { item: { ...base, type: 'launch', ...parseRun(rest) } }
      case 'chat':
        return { item: { ...base, type: 'chat', ...parseChat(rest) } }
      case 'daily':
        return { item: { ...base, type: 'daily', ...parseDaily(rest) } }
      case 'note':
        return { item: { ...base, type: 'note', path: pathOf(rest, ctx) } }
      case 'folder':
        return { item: { ...base, type: 'folder', path: pathOf(rest.replace(/\/+$/, '') || '/', ctx), steps: [{ type: 'files', label: 'All files' }] } }
      default:
        return { item: null, problem: `${link.dest}: ${kind} links belong in a page's Workflow, not the nav` }
    }
  } catch (err) {
    return { item: null, problem: `${link.dest}: ${(err as Error).message}` }
  }
}

/** A step from a Workflow list item; a line that gives none takes its place as a note opening the page. */
export function stepOf(item: PageItem, ctx: LinkContext): { step: StepItem; problem?: string } {
  const r = stepRaw(item, ctx)
  return r.step ? { step: r.step, problem: r.problem } : { step: broken(labelOf(item.link), ctx), problem: r.problem }
}

function stepRaw(item: PageItem, ctx: LinkContext): { step: StepItem | null; problem?: string } {
  const { link } = item
  if (link.kind === 'text') return { step: null, problem: `${link.label}: a Workflow line must be a link` }
  if (link.kind === 'wiki') {
    const page = ctx.page(link.target)
    return { step: { type: 'note', label: pageLabel(link, page), path: `${ctx.wiki}/${page?.rel ?? pageFile(link.target)}` } }
  }
  const { kind, rest } = targetKind(link.dest)
  const base = { label: link.label || rest, ...(link.title ? { icon: link.title } : {}) }
  try {
    switch (kind) {
      case 'link':
        return { step: { ...base, type: 'link', url: rest } }
      case 'run':
        return { step: { ...base, type: 'launch', ...parseRun(rest) } }
      case 'chat':
        return { step: { ...base, type: 'chat', ...parseChat(rest) } }
      case 'files':
      case 'git':
      case 'setup':
        return { step: { ...base, type: kind } }
      case 'daily':
        return { step: null, problem: `${link.dest}: a daily note is a nav entry, not a step` }
      default:
        return { step: { ...base, type: kind, path: rest.replace(/\/+$/, '') || '.' } }
    }
  } catch (err) {
    return { step: null, problem: `${link.dest}: ${(err as Error).message}` }
  }
}

/** A path in a nav link: `~/…` and `/…` as they are, anything else inside the wiki. */
function pathOf(p: string, ctx: LinkContext): string {
  if (p.startsWith('~') || p.startsWith('/')) return p
  return `${ctx.wiki}/${p.replace(/^\.\//, '')}`
}

/** The file a wiki link names when no page matches: `Name` → `Name.md`. */
export const pageFile = (target: string) => (NOTE_EXT.test(target) ? target : `${target}.md`)

/** A Markdown link; a destination with spaces or parentheses goes in angle brackets, as CommonMark wants. */
const mdLink = (label: string, dest: string, icon?: string) => `[${label}](${/[\s()<>]/.test(dest) ? `<${dest}>` : dest}${icon ? ` "${icon}"` : ''})`

/** A nav entry or step as the link text of its list item. */
export function linkOf(item: NavItem | StepItem, ctx: Pick<LinkContext, 'wiki' | 'linkTo'>): string {
  if ('page' in item && typeof item.page === 'string') {
    const to = ctx.linkTo(item.page)
    const name = to.slice(to.lastIndexOf('/') + 1)
    return item.label === name ? `[[${to}]]` : `[[${to}|${item.label}]]`
  }
  const icon = 'icon' in item ? item.icon : undefined
  switch (item.type) {
    case 'group':
      return item.label
    case 'shared':
      throw new PageError('A shared entry is the page itself, linked from both drawers')
    case 'link':
      return mdLink(item.label, item.url, icon)
    case 'launch':
      return mdLink(item.label, renderRun(item), icon)
    case 'chat':
      return mdLink(item.label, renderChat(item), icon)
    case 'daily':
      return mdLink(item.label, renderDaily(item), icon)
    case 'files':
    case 'git':
    case 'setup':
      return mdLink(item.label, `${item.type}:`, icon)
    case 'note':
    case 'report':
    case 'file':
      return mdLink(item.label, withKind(relPath(item.path, ctx.wiki), item.type), icon)
    case 'folder': {
      const p = relPath(item.path ?? '~', ctx.wiki)
      return mdLink(item.label, withKind(p.endsWith('/') || p === '~' || p === '/' ? p : `${p}/`, 'folder'), icon)
    }
  }
}

/** A destination read back as `kind`: as it is when its shape says so, else with the override scheme (`note:plan.txt`). */
function withKind(dest: string, kind: 'note' | 'report' | 'file' | 'folder'): string {
  return targetKind(dest).kind === kind ? dest : `${kind}:${dest}`
}

/** A path inside the wiki written relative to it; others as they are. */
function relPath(p: string, wiki: string): string {
  const w = wiki.replace(/\/+$/, '')
  return p.startsWith(`${w}/`) ? p.slice(w.length + 1) : p
}

// Editing lines

/** The list under a heading (or the lead list), as the lines it occupies. */
function listOf(page: Page, section: number | null): { items: PageItem[]; after: number } {
  if (section === null) return { items: page.lead, after: page.body }
  const s = page.sections[section]
  if (!s) throw new PageError(`Heading ${section} does not exist`)
  return { items: s.items, after: s.line + 1 }
}

function nth<T>(list: T[], i: number, what: string): T {
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new PageError(`${what} ${i} does not exist`)
  return list[i]
}

const clamp = (i: number | undefined, len: number) => (i === undefined || !Number.isInteger(i) ? len : Math.max(0, Math.min(i, len)))

/** Insert item lines into the list of `section` (or a group's children when `group` is given) at `index`. */
export function insertItem(text: string, section: number | null, group: number | undefined, index: number | undefined, link: string): string {
  const page = parsePage(text)
  const lines = page.lines
  let items: PageItem[]
  let at: number
  let indent = 0
  if (group === undefined) {
    const list = listOf(page, section)
    items = list.items
    at = list.after
    if (items.length === 0) {
      // `## Title`, a blank line, then the list. The empty string a trailing newline leaves is not that blank line.
      const blank = lines[at] !== undefined && lines[at].trim() === '' && at < lines.length - 1
      if (blank) at += 1
      else if (section !== null) {
        lines.splice(at, 0, '')
        at += 1
      }
    }
  } else {
    const parent = nth(listOf(page, section).items, group, 'Entry')
    if (parent.link.kind !== 'text') throw new PageError(`Entry ${group} is not a group`)
    items = parent.children
    at = parent.line + 1
    indent = Math.max(2, (parent.children[0]?.indent ?? 2))
  }
  const i = clamp(index, items.length)
  if (items.length) at = i < items.length ? items[i].line : items[items.length - 1].end
  const after = !items.length && group === undefined && lines[at] !== undefined && lines[at].trim() !== '' ? [''] : []
  lines.splice(at, 0, `${' '.repeat(indent)}- ${link}`, ...after)
  return lines.join('\n')
}

/** Remove an item and its children. */
export function removeItem(text: string, section: number | null, group: number | undefined, index: number): string {
  const page = parsePage(text)
  const item = itemAt(page, section, group, index)
  page.lines.splice(item.line, item.end - item.line)
  return page.lines.join('\n')
}

/** Replace the link of an item, keeping anything else on its line. */
export function replaceLink(text: string, section: number | null, group: number | undefined, index: number, link: string): string {
  const page = parsePage(text)
  const item = itemAt(page, section, group, index)
  const line = page.lines[item.line]
  page.lines[item.line] = line.slice(0, item.span[0]) + link + line.slice(item.span[1])
  return page.lines.join('\n')
}

/** Move an item (with its children) within the page: between headings, into or out of groups. */
export function moveItem(text: string, from: { section: number; group?: number; index: number }, to: { section: number; group?: number; index: number }): string {
  const page = parsePage(text)
  const item = itemAt(page, from.section, from.group, from.index)
  const block = page.lines.slice(item.line, item.end)
  if (to.group !== undefined && item.link.kind === 'text') throw new PageError('A group cannot contain another group')
  const base = item.indent
  const without = removeItem(text, from.section, from.group, from.index)
  const want = to.group === undefined ? 0 : 2
  const shifted = block.map((l) => {
    const cur = l.length - l.trimStart().length
    return ' '.repeat(Math.max(0, cur - base + want)) + l.trimStart()
  })
  // After the removal, indexes in the same heading shift by one when the item came from before the target.
  let { group, index } = to
  if (from.section === to.section) {
    if (from.group === undefined && to.group !== undefined && from.index < to.group) group = to.group - 1
    else if (from.group === to.group && from.index < to.index) index -= 1
  }
  return insertBlock(without, to.section, group, index, shifted)
}

function insertBlock(text: string, section: number | null, group: number | undefined, index: number, block: string[]): string {
  const withOne = insertItem(text, section, group, index, '\u0000')
  const lines = withOne.split('\n')
  const at = lines.findIndex((l) => l.endsWith('- \u0000'))
  lines.splice(at, 1, ...block)
  return lines.join('\n')
}

function itemAt(page: Page, section: number | null, group: number | undefined, index: number): PageItem {
  const items = listOf(page, section).items
  if (group === undefined) return nth(items, index, 'Entry')
  const parent = nth(items, group, 'Entry')
  if (parent.link.kind !== 'text') throw new PageError(`Entry ${group} is not a group`)
  return nth(parent.children, index, 'Entry')
}

/** Add a `## Title` heading (and a blank line before it) at `index` among the headings. */
export function addSection(text: string, title: string, index?: number): string {
  const page = parsePage(text)
  const lines = page.lines
  const i = clamp(index, page.sections.length)
  const at = i < page.sections.length ? page.sections[i].line : endOf(lines)
  const block = [`## ${title}`]
  if (at > 0 && lines[at - 1]?.trim() !== '') block.unshift('')
  if (at < lines.length && lines[at]?.trim() !== '') block.push('')
  lines.splice(at, 0, ...block)
  return lines.join('\n')
}

export function renameSection(text: string, index: number, title: string): string {
  const page = parsePage(text)
  const s = nth(page.sections, index, 'Heading')
  page.lines[s.line] = `## ${title}`
  return page.lines.join('\n')
}

/** Remove a heading with everything under it, up to the next heading; the last one takes the blank lines before it. */
export function deleteSection(text: string, index: number): string {
  const page = parsePage(text)
  const s = nth(page.sections, index, 'Heading')
  const next = page.sections[index + 1]
  const lines = page.lines
  let start = s.line
  if (!next) while (start > 0 && lines[start - 1].trim() === '') start--
  lines.splice(start, (next ? next.line : lines.length) - start)
  if (!next && lines.length && lines[lines.length - 1] !== '') lines.push('')
  return lines.join('\n')
}

export function moveSection(text: string, from: number, to: number): string {
  const page = parsePage(text)
  const s = nth(page.sections, from, 'Heading')
  const next = page.sections[from + 1]
  const end = next ? next.line : page.lines.length
  const block = page.lines.slice(s.line, end)
  while (block.length && block[block.length - 1].trim() === '') block.pop()
  const without = deleteSection(text, from)
  const target = clamp(to, page.sections.length - 1)
  const rest = parsePage(without)
  const lines = rest.lines
  const at = target < rest.sections.length ? rest.sections[target].line : endOf(lines)
  const ins = [...block]
  if (at > 0 && lines[at - 1]?.trim() !== '') ins.unshift('')
  if (at < lines.length && lines[at]?.trim() !== '') ins.push('')
  lines.splice(at, 0, ...ins)
  return lines.join('\n')
}

/** Where to append: before the empty string a trailing newline leaves, so the file keeps ending with one. */
function endOf(lines: string[]): number {
  return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

/** The heading titled `title` (ignoring case), or null. */
export const sectionNamed = (page: Page, title: string) => {
  const i = page.sections.findIndex((s) => s.title.trim().toLowerCase() === title.toLowerCase())
  return i < 0 ? null : i
}

// Frontmatter edits

/** Set (or with null remove) a frontmatter key, keeping the block's comments; the block is made or dropped as needed. */
export function setMeta(text: string, key: string, value: unknown): string {
  const m = FRONTMATTER.exec(text)
  const doc: Document = m ? parseDocument(m[1]) : new Document({})
  if (doc.errors.length) throw new PageError('The frontmatter is not valid YAML; fix it first')
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never
  const existing = doc.get(key, true)
  if (value === null || value === undefined || value === '') doc.delete(key)
  // A scalar keeps its node, and with it the comment on its line.
  else if (isScalar(existing) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) existing.value = value
  else doc.set(key, doc.createNode(value))
  const body = m ? text.slice(m[0].length) : text
  if (!isMap(doc.contents) || doc.contents.items.length === 0) return body
  const block = doc.toString().replace(/\n$/, '')
  return `---\n${block}\n---\n${body}`
}

/** Several keys at once. */
export function setMetas(text: string, values: Record<string, unknown>): string {
  let out = text
  for (const [k, v] of Object.entries(values)) out = setMeta(out, k, v)
  return out
}
