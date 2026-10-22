import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { noteFileName, type NoteSummary } from '../shared/config-schema.ts'
import { normalizePath, parseWiki, remarkWikiLinks, resolveHref, resolveWiki, slug, WIKI_HREF } from '../src/lib/wikilinks.ts'

const render = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkWikiLinks] }, md))

const note = (path: string, rel: string | null): NoteSummary => ({
  path,
  rel,
  name: path.split('/').pop()!.replace(/\.[^.]+$/, ''),
  mtime: 0,
})

const NOTES = [
  note('~/notes/Ideas.md', 'Ideas.md'),
  note('~/notes/work/Ideas.md', 'work/Ideas.md'),
  note('~/notes/work/Deploy plan.md', 'work/Deploy plan.md'),
  note('~/notes/archive/old/Deploy plan.md', 'archive/old/Deploy plan.md'),
  note('~/repo/RUNBOOK.md', null),
]

describe('wiki links in the Markdown pipeline', () => {
  it('turns [[Name]] into a link with the label shown', () => {
    const html = render('See [[Deploy plan]] and [[Ideas|my ideas]].')
    expect(html).toContain(`<a href="${WIKI_HREF}${encodeURIComponent('Deploy plan')}" class="wikilink">Deploy plan</a>`)
    expect(html).toContain(`<a href="${WIKI_HREF}${encodeURIComponent('Ideas|my ideas')}" class="wikilink">my ideas</a>`)
    expect(html).toContain('See ')
    expect(html).toContain(' and ')
  })

  it('leaves code, empty links and links inside links alone', () => {
    const html = render('`[[not a link]]`\n\n```\n[[nor this]]\n```\n\n[[ ]] and [x [[y]]](https://e.test)')
    expect(html).toContain('<code>[[not a link]]</code>')
    expect(html).toContain('[[nor this]]')
    expect(html).toContain('[[ ]]')
    expect(html).not.toContain('class="wikilink"')
  })

  it('works inside lists, tables and emphasis', () => {
    const html = render('- [ ] read [[Ideas]]\n\n| a |\n| - |\n| *[[Ideas]]* |\n')
    expect(html.match(/class="wikilink"/g)).toHaveLength(2)
    expect(html).toContain('type="checkbox"')
  })
})

describe('parseWiki', () => {
  it('splits path, heading and alias', () => {
    expect(parseWiki('work/Ideas#Next steps|next')).toEqual({ target: 'work/Ideas', heading: 'Next steps', label: 'next' })
    expect(parseWiki(' Ideas#Top ')).toEqual({ target: 'Ideas', heading: 'Top', label: 'Ideas › Top' })
    expect(parseWiki('Ideas')).toEqual({ target: 'Ideas', heading: undefined, label: 'Ideas' })
  })
})

describe('resolveWiki', () => {
  it('matches a path inside the notes folder exactly, ignoring case and extension', () => {
    expect(resolveWiki('work/ideas', NOTES)?.path).toBe('~/notes/work/Ideas.md')
    expect(resolveWiki('work/Ideas.md', NOTES)?.path).toBe('~/notes/work/Ideas.md')
    expect(resolveWiki('nope/Ideas', NOTES)).toBeNull()
  })

  it('prefers the linking note’s folder, then the shortest path', () => {
    expect(resolveWiki('Ideas', NOTES, '~/notes/work/Deploy plan.md')?.path).toBe('~/notes/work/Ideas.md')
    expect(resolveWiki('ideas', NOTES)?.path).toBe('~/notes/Ideas.md')
    expect(resolveWiki('Deploy plan', NOTES)?.path).toBe('~/notes/work/Deploy plan.md')
  })

  it('reaches note entries outside the notes folder by name', () => {
    expect(resolveWiki('runbook', NOTES)?.path).toBe('~/repo/RUNBOOK.md')
    expect(resolveWiki('Missing', NOTES)).toBeNull()
  })
})

describe('relative links', () => {
  it('resolves against the note’s folder', () => {
    expect(resolveHref('other.md', '~/notes/work/a.md')).toEqual({ path: '~/notes/work/other.md', hash: undefined })
    expect(resolveHref('../Ideas.md#top', '~/notes/work/a.md')).toEqual({ path: '~/notes/Ideas.md', hash: 'top' })
    expect(resolveHref('img/My%20pic.png', '~/notes/a.md')?.path).toBe('~/notes/img/My pic.png')
    expect(resolveHref('~/x.md', '~/notes/a.md')?.path).toBe('~/x.md')
    expect(resolveHref('/abs/x.md', '~/notes/a.md')?.path).toBe('/abs/x.md')
  })

  it('ignores URLs and anchors', () => {
    expect(resolveHref('https://e.test/x.md', '~/a.md')).toBeNull()
    expect(resolveHref('mailto:x@e.test', '~/a.md')).toBeNull()
    expect(resolveHref('#top', '~/a.md')).toBeNull()
  })

  it('keeps a .. it cannot collapse', () => {
    expect(normalizePath('~/../x.md')).toBe('~/../x.md')
    expect(normalizePath('/a/./b/../c.md')).toBe('/a/c.md')
  })
})

describe('names', () => {
  it('slugs headings like GitHub', () => {
    expect(slug('Deploy steps!')).toBe('deploy-steps')
    expect(slug('  Älä  unohda  ')).toBe('älä-unohda')
  })

  it('makes safe note file names', () => {
    expect(noteFileName('Deploy plan')).toBe('Deploy plan.md')
    expect(noteFileName('a/b\\c')).toBe('a-b-c.md')
    expect(noteFileName('..hidden')).toBe('hidden.md')
    expect(noteFileName('Notes.md')).toBe('Notes.md')
    expect(noteFileName('  ...  ')).toBeNull()
  })
})
