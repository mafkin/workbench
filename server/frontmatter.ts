// YAML frontmatter at the top of a Markdown file: notes, Claude's skills and
// agents, and (part 11) the pages that configure a profile.
import { parse as parseYaml } from 'yaml'
import { FRONTMATTER } from '../shared/wikilinks.ts'
import { maskText } from './mask.ts'

export type Json = Record<string, unknown>
export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The frontmatter as data and the text after it. Broken YAML gives `{}` and an error without the quoted text. */
export function frontmatter(text: string): { data: Json; body: string; error?: string } {
  const m = FRONTMATTER.exec(text)
  if (!m) return { data: {}, body: text }
  const body = text.slice(m[0].length)
  try {
    const data = parseYaml(m[1])
    return { data: isObj(data) ? data : {}, body }
  } catch (err) {
    // The message's first line only: the rest quotes the file.
    return { data: {}, body, error: maskText(String((err as Error).message).split('\n')[0]) }
  }
}
