// Profile settings: the active profile's name, accent, home and notes folder
// (written to its YAML with Undo), plus adding and removing profiles. A new
// profile is a file of its own; a removed one's file goes to the Trash.
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ACCENTS, PROFILE_ID, PROFILE_ID_RULE, type Op, type ProfileState } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'

interface Props {
  active: ProfileState
  profiles: ProfileState[]
  /** Opened from "Add profile…": focus the new profile's name. */
  addFirst?: boolean
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  onSwitch: (id: string) => void
  /** Fetch the profiles again; switching waits for it, so the new list is not overtaken. */
  onChanged: () => Promise<unknown>
  onClose: () => void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const HEX = /^#[0-9a-fA-F]{6}$/
/** A file name from a display name: "Side Projects" → side-projects. */
const idFrom = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

export function ProfileDialog({ active, profiles, addFirst, run, onSwitch, onChanged, onClose }: Props) {
  const p = active.profile
  const [name, setName] = useState(p?.name ?? '')
  const [accent, setAccent] = useState(p?.accent ?? ACCENTS[0])
  const [home, setHome] = useState(p?.home ?? '')
  const [newWiki, setNewWiki] = useState('')
  const [wikiEdited, setWikiEdited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newId, setNewId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [copy, setCopy] = useState(false)
  const [removing, setRemoving] = useState<ProfileState | null>(null)
  const newNameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addFirst) newNameRef.current?.focus()
  }, [addFirst])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !removing && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, removing])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!p) return
    if (!name.trim()) return setError('A name is required')
    if (!HEX.test(accent)) return setError('Accent must be a #rrggbb colour')
    const ops: Op[] = []
    const set = (key: 'name' | 'accent' | 'home', value: string, was: string | undefined) => value.trim() !== (was ?? '') && ops.push({ op: 'setProfileField', key, value: value.trim() })
    set('name', name, p.name)
    set('accent', accent, p.accent)
    set('home', home, p.home)
    if (ops.length && (await run(ops, 'Profile settings saved'))) onClose()
    else if (!ops.length) onClose()
  }

  async function add(e: React.FormEvent) {
    e.preventDefault()
    const id = newId.trim()
    if (!newName.trim()) return setError('The new profile needs a name')
    if (!PROFILE_ID.test(id)) return setError(PROFILE_ID_RULE)
    try {
      await api.createProfile(id, newName.trim(), copy ? active.id : undefined, newWiki.trim() || `~/notes/${id}`)
      await onChanged()
      onSwitch(id)
      onClose()
    } catch (err) {
      setError(message(err))
    }
  }

  async function remove(target: ProfileState) {
    setRemoving(null)
    try {
      await api.removeProfile(target.id)
      await onChanged()
    } catch (err) {
      setError(message(err))
    }
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog profile-dialog" role="dialog" aria-label="Profile settings">
        <header>
          Profile settings
          <small>{active.id}.yaml · saved in the file, comments kept</small>
        </header>
        <form className="body" aria-label="This profile" onSubmit={save}>
          {!p && <span className="err">This profile's file is broken; fix it before changing its settings.</span>}
          <label className="field">
            <span>Name</span>
            <input name="name" value={name} onChange={(e) => setName(e.target.value)} disabled={!p} />
          </label>
          <div className="field">
            <span>Accent</span>
            <div className="accent-row" role="radiogroup" aria-label="Accent">
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={accent.toLowerCase() === a}
                  aria-label={a}
                  className={cx('swatch', accent.toLowerCase() === a && 'on')}
                  style={{ background: a }}
                  onClick={() => setAccent(a)}
                  disabled={!p}
                />
              ))}
              <input type="color" aria-label="Other accent" value={HEX.test(accent) ? accent : '#7d93ab'} onChange={(e) => setAccent(e.target.value)} disabled={!p} />
              <input className="mono hex" name="accent" value={accent} onChange={(e) => setAccent(e.target.value)} disabled={!p} aria-label="Accent colour" />
            </div>
          </div>
          <label className="field">
            <span>Home folder</span>
            <input className="mono" name="home" value={home} onChange={(e) => setHome(e.target.value)} placeholder="~/work" disabled={!p} />
            <span className="hint">The file browser may open it and everything inside. Empty: only the notes folder and projects.</span>
          </label>
          <div className="field">
            <span>Wiki folder</span>
            <span className="mono wiki-folder">{p?.notes ?? '—'}</span>
            <span className="hint">The profile’s pages (index.md, projects, drawers, agents), notes, daily notes and context live here. To move it, move the folder and change its line in settings.yaml.</span>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={!p}>
              Save
            </button>
          </div>
        </form>

        <div className="body profiles-list">
          <h3 className="section-label">Profiles</h3>
          <ul>
            {profiles.map((q, i) => (
              <li key={q.id} className={cx(q.id === active.id && 'current')}>
                <span className="dot" style={{ background: q.profile?.accent ?? 'var(--muted)' }} />
                <span className="name">{q.profile?.name ?? q.id}</span>
                <span className="mono id">
                  {q.wiki ?? q.id} · Ctrl+{i + 1}
                </span>
                <button className="icon-btn danger" aria-label={`Remove ${q.profile?.name ?? q.id}`} title="Remove from the switcher; its wiki folder stays" disabled={profiles.length <= 1} onClick={() => setRemoving(q)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
          <form className="add-profile" aria-label="Add profile" onSubmit={add}>
            <input
              ref={newNameRef}
              name="newName"
              value={newName}
              placeholder="New profile name"
              aria-label="New profile name"
              onChange={(e) => {
                setNewName(e.target.value)
                if (!idEdited) {
                  setNewId(idFrom(e.target.value))
                  if (!wikiEdited) setNewWiki(`~/notes/${idFrom(e.target.value)}`)
                }
              }}
            />
            <input
              className="mono"
              name="newId"
              value={newId}
              placeholder="id"
              aria-label="Profile id"
              onChange={(e) => {
                setNewId(e.target.value)
                setIdEdited(true)
                if (!wikiEdited) setNewWiki(`~/notes/${e.target.value}`)
              }}
            />
            <input
              className="mono"
              name="newWiki"
              value={newWiki}
              placeholder="~/notes/id"
              aria-label="Wiki folder"
              onChange={(e) => {
                setNewWiki(e.target.value)
                setWikiEdited(true)
              }}
            />
            <label className="check">
              <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Copy {p?.name ?? active.id}'s nav (index.md) and Workflow.md
            </label>
            <button type="submit" className="btn" disabled={!newName.trim() || !newId.trim()}>
              <Plus size={13} /> Add profile
            </button>
          </form>
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
      {removing && (
        <ConfirmDialog title={`Remove ${removing.profile?.name ?? removing.id}?`} action="Remove" onCancel={() => setRemoving(null)} onConfirm={() => void remove(removing)}>
          Its file, {removing.id}.yaml, goes to the Trash; restore it from there to bring the profile back.
        </ConfirmDialog>
      )}
    </div>
  )
}
