import { FilePlus, FileText, Hash, Search } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { NotesOverview, SearchHit } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { NotesFolderHint } from './NotesFolderHint.tsx'

/** Text with the given [start, end) ranges wrapped in <mark>. */
export function marked(text: string, ranges: [number, number][]): ReactNode[] {
  const out: ReactNode[] = []
  let at = 0
  for (const [s, e] of ranges) {
    if (s < at) continue
    if (s > at) out.push(text.slice(at, s))
    out.push(<mark key={s}>{text.slice(s, e)}</mark>)
    at = e
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function nameRanges(name: string, query: string): [number, number][] {
  const lower = name.toLowerCase()
  const ranges: [number, number][] = []
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = lower.indexOf(term)
    if (at >= 0) ranges.push([at, at + term.length])
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

const when = (mtime: number) => new Date(mtime).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Search results for the top-bar box. An empty query lists notes, newest
 * first, under the wiki's tags and the pages its links name but nobody wrote.
 */
export function SearchView({ query, onQuery, onResults }: { query: string; onQuery?: (query: string) => void; onResults: (hits: SearchHit[]) => void }) {
  const notes = useNotes()
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overview, setOverview] = useState<NotesOverview | null>(null)
  const q = query.trim()

  // Tags and pages to write, before a query; refreshed when the notes change.
  useEffect(() => {
    if (q) return
    let live = true
    api.notesOverview(notes.profile).then((o) => live && setOverview(o), () => live && setOverview(null))
    return () => {
      live = false
    }
  }, [q, notes.profile, notes.list])

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api.searchNotes(notes.profile, q).then(
        (h) => {
          if (!live) return
          setHits(h)
          setError(null)
          onResults(h)
        },
        (err) => live && setError(err instanceof Error ? err.message : String(err)),
      )
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, notes.profile])

  return (
    <div className="page">
      <div className="page-kicker">Notes</div>
      <h1 className="page-title">
        <Search size={22} className="icon" />
        {q ? `“${q}”` : 'Recent notes'}
      </h1>
      <p className="page-sub">
        {error ?? (hits ? `${hits.length} ${hits.length === 1 ? 'note' : 'notes'}` : 'Searching…')}
        {notes.root ? (
          <>
            {' in '}
            <span className="mono">{notes.root}</span> and note entries
          </>
        ) : (
          ' among note entries'
        )}
      </p>
      {!notes.root && <NotesFolderHint compact />}
      {!q && overview && overview.tags.length > 0 && (
        <section className="search-overview" aria-label="Tags">
          <div className="section-label">Tags</div>
          <div className="tag-list">
            {overview.tags.map((t) => (
              <button key={t.tag} className="chip tag" onClick={() => onQuery?.(`#${t.tag}`)} title={`Notes tagged #${t.tag}`}>
                <Hash size={11} />
                {t.tag}
                <span className="count">{t.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {!q && overview && overview.missing.length > 0 && (
        <section className="search-overview" aria-label="Pages to write">
          <div className="section-label">Pages to write</div>
          <ul className="missing-pages">
            {overview.missing.map((m) => (
              <li key={m.name.toLowerCase()}>
                <button onClick={() => void notes.create(m.name)} title={`Create ${m.name} from the page template`}>
                  <FilePlus size={14} className="icon" />
                  <span className="hit-name">{m.name}</span>
                  <span className="hit-path">
                    linked from {m.count === 1 ? m.from : `${m.count} notes`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!q && overview && (overview.tags.length > 0 || overview.missing.length > 0) && <div className="section-label">Recent notes</div>}
      {hits && hits.length === 0 && q && <div className="placeholder">No note contains every word of “{q}”.</div>}
      <ul className="search-results">
        {hits?.map((h) => (
          <li key={h.path}>
            <button onClick={() => notes.open(h.path)} title={h.path}>
              <span className="hit-head">
                <FileText size={14} className="icon" />
                <span className="hit-name">{marked(h.name, nameRanges(h.name, q))}</span>
                <span className="hit-path mono">{h.rel ?? h.path}</span>
                <span className="hit-date">{when(h.mtime)}</span>
              </span>
              {h.lines.map((l) => (
                <span className="hit-line" key={l.line}>
                  <span className="ln">{l.line}</span>
                  <span>{marked(l.text, l.ranges)}</span>
                </span>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
