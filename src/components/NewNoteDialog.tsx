import { useEffect, useRef, useState } from 'react'
import { joinNotes, noteFileName } from '../../shared/config-schema.ts'
import { useNotes } from '../lib/notes-ctx.ts'

interface Props {
  context: string
  onClose: () => void
  /** Create the file and its nav entry; resolves to an error message, or null when done. */
  onCreate: (title: string, path: string) => Promise<string | null>
}

/** Quick-create: a title becomes `<notes>/<title>.md` and a note entry under the heading or group. */
export function NewNoteDialog({ context, onClose, onCreate }: Props) {
  const { root } = useNotes()
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const file = noteFileName(title)
  const path = root && file ? joinNotes(root, file) : null

  useEffect(() => input.current?.focus(), [root])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!path) {
      setError(root ? 'Give the note a title' : 'Set a notes folder first')
      return
    }
    setBusy(true)
    const err = await onCreate(title.trim(), path)
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-label="New note">
        <header>
          New note
          <small>{context}</small>
        </header>
        <div className="body">
            <label className="field">
              <span>Title</span>
              <input
                ref={input}
                name="title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  setError(null)
                }}
                placeholder="Deploy checklist"
              />
              {error ? <span className="err">{error}</span> : <span className="hint mono">{path ?? `${root}/…`}</span>}
            </label>
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !path}>
            Create
          </button>
        </footer>
      </form>
    </div>
  )
}
