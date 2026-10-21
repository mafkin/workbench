// Links inside notes: [[wiki links]], relative links between notes, and heading anchors.
import { normalizePath, NOTE_EXT, type NoteSummary } from '../../shared/config-schema.ts'

export { normalizePath }

export interface WikiLink {
  target: string
  heading?: string
  label: string
}

/** Wiki links become ordinary links with this href, which survives react-markdown's URL check. */
export const WIKI_HREF = '#wiki:'

const WIKI = /\[\[([^[\]\n]+?)\]\]/g

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

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  data?: unknown
}

/** Remark plugin: turn `[[…]]` in text into links. Code is left alone, as is text already inside a link. */
export function remarkWikiLinks() {
  return (tree: MdNode) => transform(tree)
}

function transform(node: MdNode) {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  const out: MdNode[] = []
  for (const child of node.children) {
    if (child.type !== 'text' || !child.value?.includes('[[')) {
      transform(child)
      out.push(child)
      continue
    }
    const value = child.value
    let last = 0
    for (const m of value.matchAll(WIKI)) {
      const link = parseWiki(m[1])
      if (!link.target) continue
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
      out.push({
        type: 'link',
        url: WIKI_HREF + encodeURIComponent(m[1]),
        children: [{ type: 'text', value: link.label }],
        data: { hProperties: { className: ['wikilink'] } },
      })
      last = m.index + m[0].length
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  }
  node.children = out
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

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

/** Heading anchor, GitHub style: `Deploy steps!` -> `deploy-steps`. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}
