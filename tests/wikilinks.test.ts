import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { noteFileName, type NoteSummary } from '../shared/config-schema.ts'
import { blankFrontmatter, linkPath, linksIn, normalizePath, parseWiki, relativePath, remarkWikiLinks, resolveHref, resolveProject, resolveWiki, rewriteLinks, slug, tagsIn, WIKI_HREF } from '../src/lib/wikilinks.ts'

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

describe('frontmatter in the view', () => {
  it('blanks the block but keeps the line numbers of what follows', () => {
    const text = '---\ntitle: x\ntags: [a]\n---\n# Head\n- [ ] task\n'
    expect(blankFrontmatter(text)).toBe('\n\n\n\n# Head\n- [ ] task\n')
    expect(blankFrontmatter('# No block\n---\nnot front\n')).toBe('# No block\n---\nnot front\n')
    expect(blankFrontmatter('---\r\na: 1\r\n---\r\nbody')).toBe('\n\n\nbody')
  })
})

describe('links in text', () => {
  it('finds wiki links and relative Markdown links with their lines and offsets', () => {
    const found = linksIn('See [[A]] and [b](b.md "t").\n\n![img](pics/x.png) [[C|see]] <https://x.y>')
    expect(found).toEqual([
      { line: 1, start: 4, length: 5, kind: 'wiki', inner: 'A' },
      { line: 1, start: 14, length: 13, kind: 'md', inner: 'b.md' },
      { line: 3, start: 0, length: 18, kind: 'md', inner: 'pics/x.png' },
      { line: 3, start: 19, length: 9, kind: 'wiki', inner: 'C|see' },
    ])
  })

  it('resolves a found link to a note path, or null', () => {
    const from = '~/notes/work/Ideas.md'
    expect(linkPath({ line: 1, start: 0, length: 0, kind: 'wiki', inner: 'Deploy plan#x' }, from, NOTES)).toBe('~/notes/work/Deploy plan.md')
    expect(linkPath({ line: 1, start: 0, length: 0, kind: 'md', inner: '../Ideas.md' }, from, NOTES)).toBe('~/notes/Ideas.md')
    expect(linkPath({ line: 1, start: 0, length: 0, kind: 'md', inner: 'https://x.y' }, from, NOTES)).toBeNull()
    expect(linkPath({ line: 1, start: 0, length: 0, kind: 'wiki', inner: 'Nope' }, from, NOTES)).toBeNull()
  })
})

describe('rewriting links for a rename', () => {
  const old = NOTES[2] // ~/notes/work/Deploy plan.md
  const next = { path: '~/notes/work/Release plan.md', name: 'Release plan', rel: 'work/Release plan.md' }

  it('rewrites every form and keeps headings, aliases and spacing', () => {
    const text = 'See [[Deploy plan]], [[ work/Deploy plan |the plan]], [[Deploy plan#Steps]] and [[deploy plan.md]].'
    const out = rewriteLinks(text, '~/notes/work/Ideas.md', NOTES, old, next)
    expect(out).toEqual({
      text: 'See [[Release plan]], [[work/Release plan|the plan]], [[Release plan#Steps]] and [[Release plan]].',
      count: 4,
    })
  })

  it('rewrites relative Markdown links, encoded like the original, from any folder', () => {
    const near = rewriteLinks('[p](Deploy%20plan.md#steps) and ![i](Deploy%20plan.md)', '~/notes/work/Ideas.md', NOTES, old, next)
    expect(near.text).toBe('[p](Release%20plan.md#steps) and ![i](Release%20plan.md)')
    const far = rewriteLinks('[p](../../work/Deploy%20plan.md)', '~/notes/archive/old/X.md', NOTES, old, next)
    expect(far).toEqual({ text: '[p](../../work/Release%20plan.md)', count: 1 })
  })

  it('leaves other links alone: another note with the same name, URLs, missing notes', () => {
    // From the archive folder, the bare name resolves to the archive's own Deploy plan.
    const text = '[[Deploy plan]] [[Ideas]] [x](https://x.y/Deploy%20plan.md) [[Nope]]'
    expect(rewriteLinks(text, '~/notes/archive/old/X.md', NOTES, old, next)).toEqual({ text, count: 0 })
  })

  it('computes relative paths', () => {
    expect(relativePath('~/notes/a/b.md', '~/notes/a/c.md')).toBe('c.md')
    expect(relativePath('~/notes/a/b.md', '~/notes/c.md')).toBe('../c.md')
    expect(relativePath('~/notes/b.md', '~/notes/a/c.md')).toBe('a/c.md')
    expect(relativePath('~/notes/a/x/b.md', '~/notes/c/d.md')).toBe('../../c/d.md')
  })
})

describe('links into projects', () => {
  const projects = [
    { label: 'Tuohi', path: '~/Projects/tuohi' },
    { label: 'IFC Checker', path: '~/ifc' },
  ]

  it('reaches a file in a project by the project label, case ignored', () => {
    expect(resolveProject('Tuohi/docs/design.md', projects)).toEqual({ path: '~/Projects/tuohi/docs/design.md', note: true })
    expect(resolveProject('ifc checker/renders/a.png', projects)).toEqual({ path: '~/ifc/renders/a.png', note: false })
    expect(resolveProject('Tuohi/', projects)).toEqual({ path: '~/Projects/tuohi', note: false })
  })

  it('is null for bare names and unknown projects', () => {
    expect(resolveProject('Tuohi', projects)).toBeNull()
    expect(resolveProject('Nope/x.md', projects)).toBeNull()
  })
})

describe('tagsIn', () => {
  it('reads tags: from the frontmatter and #tags from the text, once each, lower-cased', () => {
    const text = '---\ntags: [Game, art]\n---\n# Heading\n\nAbout #game and #Art/2d, see #wip-idea. Not #1 or https://x.io/#top.\n`#code` is not one, and neither is\n\n```\n#fenced\n```\n\n(#paren) and #end.\n'
    expect(tagsIn(text, { tags: ['Game', 'art'] })).toEqual(['game', 'art', 'art/2d', 'wip-idea', 'paren', 'end'])
    expect(tagsIn('tags as a string', { tags: 'one, two #three' })).toEqual(['one', 'two', 'three'])
    expect(tagsIn('# Title\n\nno tags here\n')).toEqual([])
  })
})
