// One note: formatted, or in the editor (Ctrl+E). Edits autosave a second
// after typing stops, against the rev they started from. A change on disk
// reloads the note when nothing is unsaved; otherwise autosave pauses and a
// banner offers to reload or to keep this version.
import { Eye, FilePlus, Pencil } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import type { NoteFile } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { onNoteEvent, type NoteEvent } from '../lib/events.ts'
import { cx } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { Markdown } from './Markdown.tsx'

const NoteEditor = lazy(() => import('./NoteEditor.tsx'))

const AUTOSAVE_MS = 1000

interface Base {
  path: string
  text: string
  rev: string
}

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'missing' } | { kind: 'error'; message: string }

interface Props {
  path: string
  kicker?: ReactNode
  heading: ReactNode
  /** Inside another page (a project's note step): a small heading and no kicker. */
  compact?: boolean
  /** Shown under the title, e.g. the path row or day arrows. */
  below?: ReactNode
  /** Text for a new file; defaults to `# <title>`. */
  initialText?: () => Promise<string>
  /** Heading of a new file made from the "missing" state. */
  title: string
  /** Create the file as soon as it turns out to be missing (today's daily note). */
  autoCreate?: boolean
  missingText?: string
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function NoteView({ path, kicker, heading, compact, below, initialText, title, autoCreate, missingText }: Props) {
  const notes = useNotes()
  const ctx = useRef(notes)
  ctx.current = notes
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [base, setBaseState] = useState<Base | null>(null)
  const [draft, setDraftState] = useState('')
  const [conflict, setConflictState] = useState<{ rev: string | null } | null>(null)
  const [editing, setEditing] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Async code reads these, so it always sees the latest values.
  const r = useRef({
    base: null as Base | null,
    draft: '',
    conflict: null as { rev: string | null } | null,
    saving: false,
    again: false,
    /** A change reported while a save was in flight, looked at once it lands. */
    event: null as NoteEvent | null,
  })
  const setBase = (b: Base | null) => {
    r.current.base = b
    setBaseState(b)
  }
  const setDraft = (d: string) => {
    r.current.draft = d
    setDraftState(d)
  }
  const setConflict = (c: { rev: string | null } | null) => {
    r.current.conflict = c
    setConflictState(c)
  }

  function apply(file: NoteFile) {
    setBase({ path: file.path, text: file.text, rev: file.rev })
    setDraft(file.text)
    setConflict(null)
    setPhase({ kind: 'ready' })
  }

  async function load() {
    try {
      apply(await api.readNote(ctx.current.profile, path))
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 404) {
        setBase(null)
        if (autoCreate) await create()
        else setPhase({ kind: 'missing' })
      } else if (err instanceof api.ApiError && err.status === 403) {
        setPhase({ kind: 'error', message: 'This file is not in the notes folder and is not a note entry of this profile.' })
      } else {
        setPhase({ kind: 'error', message: message(err) })
      }
    }
  }

  async function create() {
    try {
      const text = initialText ? await initialText() : `# ${title}\n\n`
      const saved = await api.writeNote(ctx.current.profile, path, null, text)
      apply({ path: saved.path, text, rev: saved.rev, mtime: saved.mtime })
      setAtEnd(true)
      setEditing(true)
      ctx.current.changed()
    } catch (err) {
      // Someone else created it first: open theirs.
      if (err instanceof api.ApiError && err.status === 409) return load()
      setPhase({ kind: 'error', message: message(err) })
    }
  }

  async function save(keepalive = false) {
    const s = r.current
    if (!s.base || s.conflict || s.draft === s.base.text) return
    if (s.saving) {
      s.again = true
      return
    }
    s.saving = true
    setSaving(true)
    const text = s.draft
    try {
      const saved = await api.writeNote(ctx.current.profile, s.base.path, s.base.rev, text, keepalive)
      setBase({ path: saved.path, text, rev: saved.rev })
      setSaveError(null)
      ctx.current.changed()
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 409) setConflict({ rev: (err.data.rev as string | null | undefined) ?? null })
      else setSaveError(message(err))
    } finally {
      s.saving = false
      setSaving(false)
      const e = s.event
      s.event = null
      if (e) onEvent(e)
      if (s.again) {
        s.again = false
        void save()
      }
    }
  }

  /** Look at the file on disk: take it if nothing is unsaved, otherwise flag the conflict. */
  async function check() {
    try {
      const file = await api.readNote(ctx.current.profile, path)
      const s = r.current
      if (s.base && file.rev === s.base.rev) return
      if (s.base && s.draft !== s.base.text) setConflict({ rev: file.rev })
      else apply(file)
    } catch (err) {
      if (!(err instanceof api.ApiError) || err.status !== 404) return
      const s = r.current
      if (s.base && s.draft !== s.base.text) setConflict({ rev: null })
      else {
        setBase(null)
        setPhase({ kind: 'missing' })
      }
    }
  }

  function onEvent(e: NoteEvent | 'reconnected') {
    const s = r.current
    if (e !== 'reconnected') {
      if (e.path !== (s.base?.path ?? path)) return
      if (s.saving) {
        s.event = e
        return
      }
      if (s.base && e.rev === s.base.rev) return
    }
    void check()
  }

  async function keepMine() {
    const s = r.current
    if (!s.conflict || !s.base) return
    const text = s.draft
    try {
      const saved = await api.writeNote(ctx.current.profile, s.base.path, s.conflict.rev, text)
      setBase({ path: saved.path, text, rev: saved.rev })
      setConflict(null)
      ctx.current.changed()
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 409) setConflict({ rev: (err.data.rev as string | null | undefined) ?? null })
      else ctx.current.notify(`Could not save: ${message(err)}`, 'error')
    }
  }

  function toggle() {
    if (editing) void save()
    else setAtEnd(false)
    setEditing(!editing)
  }

  // Open: load it, and go straight to Edit for a note that was just created.
  useEffect(() => {
    void load()
    if (ctx.current.fresh === path) {
      setEditing(true)
      setAtEnd(true)
      ctx.current.clearFresh()
    }
  }, [])

  useEffect(() => onNoteEvent(onEvent), [])

  useEffect(() => {
    if (!base || conflict || draft === base.text) return
    const t = setTimeout(() => void save(), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [draft, base, conflict])

  // Leaving the note, or closing the window, saves what is pending.
  useEffect(() => {
    const onPageHide = () => void save(true)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      void save()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        void save()
      } else if (key === 'e' && phase.kind === 'ready') {
        if ((e.target as HTMLElement | null)?.closest?.('input, textarea, .scrim')) return
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, phase.kind])

  const dirty = !!base && draft !== base.text
  const status = conflict ? 'Conflict' : saving ? 'Saving…' : saveError ? 'Not saved' : dirty ? 'Unsaved' : 'Saved'
  const tone = conflict || saveError ? 'bad' : saving || dirty ? 'pending' : 'ok'

  return (
    <div className={cx('page note-page', compact && 'compact')}>
      {kicker && <div className="page-kicker">{kicker}</div>}
      <div className="note-head">
        <h1 className="page-title">{heading}</h1>
        {phase.kind === 'ready' && (
          <div className="note-actions">
            {(editing || tone !== 'ok') && (
              <span className={cx('save-status', tone)} title={saveError ?? undefined} aria-live="polite">
                {status}
              </span>
            )}
            <button className={cx('btn', editing && 'primary')} onClick={toggle} title={editing ? 'View (Ctrl+E)' : 'Edit (Ctrl+E)'} aria-pressed={editing}>
              {editing ? <Eye size={14} /> : <Pencil size={14} />}
              {editing ? 'View' : 'Edit'}
            </button>
          </div>
        )}
      </div>
      {below}

      {conflict && (
        <div className="note-conflict" role="alert">
          <div>
            <strong>{conflict.rev === null ? 'Deleted on disk' : 'Changed on disk'}</strong> while you were editing. Your text is
            kept here and autosave is paused.
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void load()}>
              Reload from disk
            </button>
            <button className="btn primary" onClick={() => void keepMine()}>
              Keep mine
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'loading' && <div className="note-loading">Loading…</div>}
      {phase.kind === 'error' && (
        <div className="placeholder">
          <h3>Cannot open this note</h3>
          <p>{phase.message}</p>
        </div>
      )}
      {phase.kind === 'missing' && (
        <div className="placeholder">
          <h3>{missingText ?? 'This file does not exist yet'}</h3>
          <p className="mono">{path}</p>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={() => void create()}>
            <FilePlus size={14} /> Create it
          </button>
        </div>
      )}
      {phase.kind === 'ready' &&
        (editing ? (
          <Suspense fallback={<div className="note-loading">Loading editor…</div>}>
            <div className="note-surface editing">
              <NoteEditor value={draft} onChange={setDraft} atEnd={atEnd} />
            </div>
          </Suspense>
        ) : (
          <div className="note-surface">
            {draft.trim() ? (
              <Markdown text={draft} notePath={base?.path ?? path} />
            ) : (
              <p className="note-empty">This note is empty. Press Edit (Ctrl+E) to write.</p>
            )}
          </div>
        ))}
    </div>
  )
}
