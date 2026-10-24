import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { NOTE_EXT } from '../../shared/config-schema.ts'
import { noteImage } from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { blankFrontmatter, parseWiki, remarkWikiLinks, resolveHref, resolveProject, resolveWiki, slug, WIKI_HREF } from '../lib/wikilinks.ts'

const plugins = [remarkGfm, remarkWikiLinks]

// Images resolve against the note's folder. A context rather than a closure keeps
// the image component the same across renders, so images are not fetched again.
const NotePath = createContext('')

// Ticking a task: the note's handler, and the line of the list item the box is in.
const ToggleTask = createContext<((line: number) => void) | null>(null)
const TaskLine = createContext<number | null>(null)

// A link to a heading in another note: kept here until that note's view shows it.
let pendingAnchor: { heading: string; at: number } | null = null
function takeAnchor(): string | null {
  const p = pendingAnchor
  pendingAnchor = null
  return p && Date.now() - p.at < 5000 ? p.heading : null
}

/** Plain text of a hast node, for heading anchors. */
function textOf(node: unknown): string {
  const n = node as { value?: string; children?: unknown[] } | undefined
  if (!n) return ''
  if (typeof n.value === 'string') return n.value
  return (n.children ?? []).map(textOf).join('')
}

function scrollToHeading(from: HTMLElement, id: string) {
  const root = from.closest('.markdown') ?? from
  const el = root.querySelector(`#${CSS.escape(`h-${slug(decodeURIComponent(id))}`)}`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/** Open `path` at `heading`: scroll now if it is this note, else once its view shows. */
function openAt(open: () => void, here: HTMLElement, samePath: boolean, heading?: string) {
  if (heading && samePath) return scrollToHeading(here, heading)
  if (heading) pendingAnchor = { heading, at: Date.now() }
  open()
}

/** A task's box: ticks the task in the note when the view allows it. */
function TaskBox({ checked }: { checked?: boolean }) {
  const toggle = useContext(ToggleTask)
  const line = useContext(TaskLine)
  if (!toggle || line === null) return <input type="checkbox" checked={!!checked} disabled readOnly />
  return <input type="checkbox" checked={!!checked} onChange={() => toggle(line)} aria-label={checked ? 'Done; click to undo' : 'Mark done'} />
}

/** A fenced code block, coloured once the highlighter (a lazy chunk) is loaded. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [runs, setRuns] = useState<{ text: string; cls: string }[] | null>(null)
  useEffect(() => {
    let live = true
    import('../lib/highlight.ts').then(
      (m) => live && setRuns(m.highlight(code, lang)),
      () => {},
    )
    return () => {
      live = false
    }
  }, [code, lang])
  return <code className={`language-${lang}`}>{runs ? runs.map((r, i) => (r.cls ? <span key={i} className={r.cls}>{r.text}</span> : r.text)) : code}</code>
}

/** An image's title (`![alt](x.png "A caption")`) shows under it, as a caption; inline elements, since the image sits in a paragraph. */
function captioned(img: React.ReactNode, title?: string): React.ReactNode {
  if (!title) return img
  return (
    <span className="img-figure">
      {img}
      <span className="img-caption">{title}</span>
    </span>
  )
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

  if (!target) return captioned(<img src={src} alt={alt} title={title} />, title)
  if (failed) return <span className="img-missing" title={target.path}>{alt || 'Image'}: not found or not allowed</span>
  return url ? captioned(<img src={url} alt={alt} title={title} />, title) : <span className="img-loading" />
}

/** A note rendered: GitHub-flavoured Markdown plus [[wiki links]]. Raw HTML is not rendered. */
export function Markdown({ text, notePath, onToggleTask }: { text: string; notePath: string; onToggleTask?: (line: number) => void }) {
  const notes = useNotes()
  const root = useRef<HTMLDivElement>(null)

  // Opened from a link to one of this note's headings.
  useEffect(() => {
    const heading = takeAnchor()
    if (heading && root.current) requestAnimationFrame(() => root.current && scrollToHeading(root.current, heading))
  }, [notePath])

  // Frontmatter is shown as properties above the note, not as text; blank lines keep task lines numbered.
  const shown = useMemo(() => blankFrontmatter(text), [text])

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
          // [[Project/path]]: a file in a project's folder.
          const inProject = found ? null : resolveProject(link.target, notes.projects)
          return (
            <a
              href="#"
              className={cx('wikilink', !found && !inProject && 'missing')}
              title={found ? found.path : (inProject?.path ?? `No note named "${link.target}" yet`)}
              onClick={(e) => {
                e.preventDefault()
                // [[#heading]] is a heading in this note.
                if (!link.target && link.heading) scrollToHeading(e.currentTarget, link.heading)
                else if (found) openAt(() => notes.open(found.path), e.currentTarget, found.path === notePath, link.heading)
                else if (inProject?.note) openAt(() => notes.open(inProject.path), e.currentTarget, inProject.path === notePath, link.heading)
                else if (inProject) notes.openFolder(/\/$|\/[^/.]+$/.test(link.target) ? inProject.path : inProject.path.slice(0, inProject.path.lastIndexOf('/')))
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
              if (NOTE_EXT.test(target.path)) openAt(() => notes.open(target.path), e.currentTarget, target.path === notePath, target.hash)
              else notes.notify('Only Markdown notes open in Workbench')
            }}
          >
            {children}
          </a>
        )
      },
      img: NoteImage,
      li: ({ node, className, children }) => {
        const line = (node as { position?: { start?: { line?: number } } } | undefined)?.position?.start?.line ?? null
        return (
          <TaskLine.Provider value={className?.includes('task-list-item') ? line : null}>
            <li className={className}>{children}</li>
          </TaskLine.Provider>
        )
      },
      input: ({ type, checked }) => (type === 'checkbox' ? <TaskBox checked={checked} /> : null),
      code: ({ className, children }) => {
        const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1]
        const text = String(children ?? '')
        // Fenced blocks end with a newline; inline code does not.
        return lang && text.includes('\n') ? <CodeBlock code={text.replace(/\n$/, '')} lang={lang} /> : <code className={className}>{children}</code>
      },
    }
  }, [notes, notePath])

  return (
    <div className="markdown" ref={root}>
      <NotePath.Provider value={notePath}>
        <ToggleTask.Provider value={onToggleTask ?? null}>
          <ReactMarkdown remarkPlugins={plugins} components={components}>
            {shown}
          </ReactMarkdown>
        </ToggleTask.Provider>
      </NotePath.Provider>
    </div>
  )
}
