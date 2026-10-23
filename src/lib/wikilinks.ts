// Links inside notes: [[wiki links]] turned into links by a remark plugin. The
// parsing and resolving live in shared/wikilinks.ts, which the service uses too.
import { normalizePath } from '../../shared/config-schema.ts'
import { parseWiki, WIKI_HREF } from '../../shared/wikilinks.ts'

export { normalizePath }
export * from '../../shared/wikilinks.ts'

const WIKI = /\[\[([^[\]\n]+?)\]\]/g

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
