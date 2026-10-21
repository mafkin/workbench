import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { NOTE_EXT } from '../../shared/config-schema.ts'
import { noteImage } from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { parseWiki, remarkWikiLinks, resolveHref, resolveWiki, slug, WIKI_HREF } from '../lib/wikilinks.ts'

const plugins = [remarkGfm, remarkWikiLinks]

// Images resolve against the note's folder. A context rather than a closure keeps
// the image component the same across renders, so images are not fetched again.
const NotePath = createContext('')

/** Plain text of a hast node, for heading anchors. */
function textOf(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] } | undefined
  if (!n) return ''
  if (typeof n.value === 'string') return n.value
  return (n.children ?? []).map(textOf).join('')
}

function scrollToHeading(from: HTMLElement, id: string) {
  const el = from.closest('.markdown')?.querySelector(`#${CSS.escape(`h-${slug(decodeURIComponent(id))}`)}`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function NoteImage({ src: raw, alt, title }: { src?: string | Blob; alt?: string; title?: string }) {
  const { profile } = useNotes()
  const notePath = useContext(NotePath)
  const src = typeof raw === 'string' ? raw : undefined
  const target = src && !/^(https?|data|blob):/i.test(src) ? resolveHref(src, notePath) : null
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!target) return
    let live = true
    let made: string | null = null
    noteImage(profile, target.path).then(
      (blob) => {
        if (!live) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [profile, target?.path])

  if (!target) return <img src={src} alt={alt} title={title} />
  if (failed) return <span className="img-missing" title={target.path}>{alt || 'Image'}: not found or not allowed</span>
  return url ? <img src={url} alt={alt} title={title} /> : <span className="img-loading" />
}

/** A note rendered: GitHub-flavoured Markdown plus [[wiki links]]. Raw HTML is not rendered. */
export function Markdown({ text, notePath }: { text: string; notePath: string }) {
  const notes = useNotes()

  const components = useMemo<Components>(() => {
    const heading =
      (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      ({ node, children }: { node?: unknown; children?: ReactNode }) => <Tag id={`h-${slug(textOf(node))}`}>{children}</Tag>
    return {
      h1: heading('h1'),
      h2: heading('h2'),
      h3: heading('h3'),
      h4: heading('h4'),
      h5: heading('h5'),
      h6: heading('h6'),
      a: ({ href = '', children }) => {
        if (href.startsWith(WIKI_HREF)) {
          const link = parseWiki(decodeURIComponent(href.slice(WIKI_HREF.length)))
          const found = resolveWiki(link.target, notes.list, notePath)
          return (
            <a
              href="#"
              className={cx('wikilink', !found && 'missing')}
              title={found ? found.path : `No note named "${link.target}" yet`}
              onClick={(e) => {
                e.preventDefault()
                if (found) notes.open(found.path)
                else notes.missing(link.target)
              }}
            >
              {children}
            </a>
          )
        }
        if (href.startsWith('#')) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                scrollToHeading(e.currentTarget, href.slice(1))
              }}
            >
              {children}
            </a>
          )
        }
        const target = resolveHref(href, notePath)
        if (!target) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }
        return (
          <a
            href={href}
            title={target.path}
            onClick={(e) => {
              e.preventDefault()
              if (NOTE_EXT.test(target.path)) notes.open(target.path)
              else notes.notify('Only Markdown notes open in Workbench')
            }}
          >
            {children}
          </a>
        )
      },
      img: NoteImage,
    }
  }, [notes, notePath])

  return (
    <div className="markdown">
      <NotePath.Provider value={notePath}>
        <ReactMarkdown remarkPlugins={plugins} components={components}>
          {text}
        </ReactMarkdown>
      </NotePath.Provider>
    </div>
  )
}
