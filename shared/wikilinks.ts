// Links inside notes, shared by the UI and the service: [[wiki links]],
// relative links between notes, heading anchors, frontmatter bounds, links to
// files in a project, and the rewriting a rename needs.
import { normalizePath, NOTE_EXT, stepPath, type NoteSummary } from './config-schema.ts'

export interface WikiLink {
  target: string
  heading?: string
  label: string
}

/** Wiki links become ordinary links with this href, which survives react-markdown's URL check. */
export const WIKI_HREF = '#wiki:'

const WIKI = /\[\[([^[\]\n]+?)\]\]/g
/** `[text](dest)` or `![alt](dest)` with a plain destination (no spaces, no `<>`); the title is left alone. */
const MD_LINK = /!?\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\(([^()\s<>]+)(?:\s+"[^"\n]*")?\)/g
/** A frontmatter block at the very top: `---`, YAML, `---`. */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)]
}

/** `Name`, `folder/Name`, `Name#Heading`, `Name|shown text`. */
export function parseWiki(inner: string): WikiLink {
  const [ref, alias] = splitOnce(inner, '|')
  const [target, heading] = splitOnce(ref, '#')
  const t = target.trim()
  const h = heading?.trim() || undefined
  return { target: t, heading: h, label: alias?.trim() || (h ? `${t} › ${h}` : t) }
}

export const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

/**
 * The note a wiki link points to. A path (`folder/Name`) must match inside the
 * notes folder; a bare name matches file names, preferring the linking note's
 * folder, then the notes folder over note entries elsewhere, then the shortest path.
 */
export function resolveWiki(target: string, notes: NoteSummary[], from?: string): NoteSummary | null {
  const want = target.trim().replace(/^\/+/, '').replace(NOTE_EXT, '').toLowerCase()
  if (!want) return null
  if (want.includes('/')) return notes.find((n) => n.rel !== null && n.rel.replace(NOTE_EXT, '').toLowerCase() === want) ?? null
  const matches = notes.filter((n) => n.name.toLowerCase() === want)
  const near = from ? dirOf(from) : null
  const rank = (n: NoteSummary) => (near !== null && dirOf(n.path) === near ? 0 : n.rel !== null ? 1 : 2)
  matches.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return matches[0] ?? null
}

/** Where a link or image in a note points, relative to the note's folder; null for URLs and in-page anchors. */
export function resolveHref(href: string, notePath: string): { path: string; hash?: string } | null {
  if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const [raw, hash] = splitOnce(href, '#')
  let p = raw
  try {
    p = decodeURIComponent(raw)
  } catch {
    // Keep it as written.
  }
  if (!p) return null
  if (!p.startsWith('/') && !p.startsWith('~')) p = dirOf(notePath) + p
  return { path: normalizePath(p), hash: hash || undefined }
}

/**
 * `[[Project/path/inside]]`: a file in a project's folder, by the project's
 * label (case ignored). Null when the first segment is no project.
 */
export function resolveProject(target: string, projects: { label: string; path: string }[]): { path: string; note: boolean } | null {
  const [head, rest] = splitOnce(target.trim().replace(/^\/+/, ''), '/')
  if (rest === undefined) return null
  const want = head.trim().toLowerCase()
  const project = projects.find((p) => p.label.toLowerCase() === want)
  if (!project) return null
  const path = stepPath(project.path, rest.trim() || '.')
  return { path, note: NOTE_EXT.test(path) }
}

/** Heading anchor, GitHub style: `Deploy steps!` -> `deploy-steps`. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/** The frontmatter block replaced by blank lines, so what follows keeps its line numbers. */
export function blankFrontmatter(text: string): string {
  const m = FRONTMATTER.exec(text)
  if (!m) return text
  const lines = m[0].split('\n').length - 1
  return '\n'.repeat(lines) + text.slice(m[0].length)
}

export interface FoundLink {
  /** 1-based line. */
  line: number
  /** Offset of the whole link in its line, and its length. */
  start: number
  length: number
  kind: 'wiki' | 'md'
  /** The wiki link's inside, or the Markdown destination as written. */
  inner: string
}

/** Every wiki link and relative Markdown link, line by line. Code is not skipped: a rename should reach it too. */
export function linksIn(text: string): FoundLink[] {
  const out: FoundLink[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const m of line.matchAll(WIKI)) out.push({ line: i + 1, start: m.index, length: m[0].length, kind: 'wiki', inner: m[1] })
    for (const m of line.matchAll(MD_LINK)) out.push({ line: i + 1, start: m.index, length: m[0].length, kind: 'md', inner: m[1] })
  }
  return out.sort((a, b) => a.line - b.line || a.start - b.start)
}

/** The note a found link points to, as a path, or null. */
export function linkPath(link: FoundLink, from: string, notes: NoteSummary[]): string | null {
  if (link.kind === 'wiki') {
    const { target } = parseWiki(link.inner)
    return target ? (resolveWiki(target, notes, from)?.path ?? null) : null
  }
  return resolveHref(link.inner, from)?.path ?? null
}

/** `to` relative to the folder of `from`, both `~/…` or absolute paths. */
export function relativePath(from: string, to: string): string {
  const a = dirOf(from).split('/').filter(Boolean)
  const b = to.split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...Array<string>(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

/**
 * The text with every link to `old` pointing at `next` instead: `[[Old]]`,
 * `[[folder/Old]]`, with `#heading` and `|alias` kept, and relative Markdown
 * links (encoded like the original). `count` is how many links changed.
 */
export function rewriteLinks(
  text: string,
  from: string,
  notes: NoteSummary[],
  old: NoteSummary,
  next: { path: string; name: string; rel: string | null },
): { text: string; count: number } {
  const lines = text.split('\n')
  let count = 0
  const found = linksIn(text)
  // Right to left within a line, so earlier offsets stay valid.
  for (let k = found.length - 1; k >= 0; k--) {
    const link = found[k]
    if (linkPath(link, from, notes) !== old.path) continue
    let replacement: string
    if (link.kind === 'wiki') {
      const [ref] = splitOnce(link.inner, '|')
      const [rawTarget] = splitOnce(ref, '#')
      const rest = link.inner.slice(rawTarget.length)
      const target = rawTarget.trim().includes('/') && next.rel !== null ? next.rel.replace(NOTE_EXT, '') : next.name
      replacement = `[[${target}${rest}]]`
    } else {
      const [dest, hash] = splitOnce(link.inner, '#')
      const rel = relativePath(from, next.path)
      const written = dest.includes('%') ? rel.split('/').map(encodeURIComponent).join('/') : rel
      const whole = lines[link.line - 1].slice(link.start, link.start + link.length)
      replacement = whole.replace(`(${link.inner}`, `(${written}${hash === undefined ? '' : `#${hash}`}`)
    }
    const line = lines[link.line - 1]
    lines[link.line - 1] = line.slice(0, link.start) + replacement + line.slice(link.start + link.length)
    count++
  }
  return { text: count ? lines.join('\n') : text, count }
}

const TAG = /(^|[\s(\[>,;])#([\p{L}_][\p{L}\p{N}_/-]*)/gu

/**
 * A note's tags, lower-cased and in order of first appearance: `tags:` in its
 * frontmatter (a list, or one string split on commas and spaces), then every
 * `#tag` in its text outside code (fences and backticks). A tag starts with a
 * letter, so `#1` and `# Heading` are not tags, and a URL's `#anchor` is not
 * one either (it follows a `/`, not a space).
 */
export function tagsIn(text: string, meta?: Record<string, unknown> | null): string[] {
  const out: string[] = []
  const add = (raw: string) => {
    const tag = raw.replace(/^#+/, '').replace(/[/-]+$/, '').toLowerCase()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  const listed = meta?.tags
  if (Array.isArray(listed)) for (const t of listed) if (typeof t === 'string' || typeof t === 'number') add(String(t))
  if (typeof listed === 'string') for (const t of listed.split(/[\s,]+/)) add(t)
  const body = text.replace(FRONTMATTER, '')
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(TAG)) add(m[2])
  }
  return out
}
