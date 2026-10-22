import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fillTemplate, isoDate, joinNotes, type NavItem } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { EntryIcon } from './EntryIcon.tsx'
import { NotesFolderHint } from './NotesFolderHint.tsx'
import { NoteView } from './NoteView.tsx'

type DailyItem = Extract<NavItem, { type: 'daily' }>

const DEFAULT_TEMPLATE = '# {{date}}\n\n'

/** Relative paths are inside the notes folder; `~/…` and `/…` are taken as they are. */
const inNotes = (root: string, p: string) => (/^(~|\/)/.test(p) ? p : joinNotes(root, p))

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return isoDate(d)
}

const longDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/** Today's note, created from the template the first time it is opened; arrows step through other days. */
export function DailyView({ item, kicker }: { item: DailyItem; kicker: string }) {
  const notes = useNotes()
  const [today, setToday] = useState(() => isoDate(new Date()))
  const [date, setDate] = useState(today)

  // At midnight "today" moves on, and so does the page if it was showing today.
  useEffect(() => {
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = setTimeout(() => {
      const next = isoDate(new Date())
      setDate((d) => (d === today ? next : d))
      setToday(next)
    }, midnight.getTime() - now.getTime() + 1000)
    return () => clearTimeout(timer)
  }, [today])

  if (!notes.root) {
    return (
      <div className="page">
        <div className="page-kicker">{kicker} · Daily</div>
        <h1 className="page-title">
          <EntryIcon type="daily" icon={item.icon} size={22} />
          {item.label}
        </h1>
        <NotesFolderHint />
      </div>
    )
  }

  const root = notes.root
  const path = `${inNotes(root, item.folder?.trim() || 'daily').replace(/\/+$/, '')}/${date}.md`
  const template = inNotes(root, item.template?.trim() || 'templates/daily.md')
  const initialText = async () => {
    let text = DEFAULT_TEMPLATE
    try {
      text = (await api.readNote(notes.profile, template)).text
    } catch {
      // No template: a heading with the date.
    }
    return fillTemplate(text, { date, title: date })
  }

  return (
    <NoteView
      key={path}
      path={path}
      title={date}
      kicker={`${kicker} · Daily`}
      heading={
        <>
          <EntryIcon type="daily" icon={item.icon} size={22} />
          {date === today ? item.label : longDate(date)}
        </>
      }
      below={
        <div className="daily-nav">
          <button className="icon-btn" onClick={() => setDate(shift(date, -1))} title="Previous day" aria-label="Previous day">
            <ChevronLeft size={15} />
          </button>
          <span className="daily-date">{longDate(date)}</span>
          <button className="icon-btn" onClick={() => setDate(shift(date, 1))} title="Next day" aria-label="Next day">
            <ChevronRight size={15} />
          </button>
          {date !== today && (
            <button className="btn ghost" onClick={() => setDate(today)}>
              Today
            </button>
          )}
          <span className="path mono">{path}</span>
        </div>
      }
      initialText={initialText}
      autoCreate={date === today}
      missingText={`No note for ${longDate(date)}`}
    />
  )
}
