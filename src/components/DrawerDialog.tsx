// A drawer's settings, or a new drawer: its name, logo (a picture scaled to
// 64×64), shared folder, and the drawers whose shared folders it uses. Saved
// in the profile's YAML with Undo; deleting asks first.
import { ImagePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { drawersOf, drawerSlug, hasDrawers, type Op, type Profile } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { makeLogo, putLogo } from '../lib/logos.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { DrawerLogo } from './DrawerLogo.tsx'

interface Props {
  profile: Profile
  profileId: string
  /** The drawer to edit; null for a new one. */
  index: number | null
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  /** Show the drawer by this name (a new or renamed one). */
  onShow: (name: string) => void
  onDeleted: () => void
  onClose: () => void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function DrawerDialog({ profile, profileId, index, run, onShow, onDeleted, onClose }: Props) {
  const drawers = drawersOf(profile)
  const current = index === null ? undefined : drawers[index]
  const [name, setName] = useState(current?.name ?? '')
  const [logo, setLogo] = useState(current?.logo ?? '')
  const [folder, setFolder] = useState(current?.folder ?? '')
  const [uses, setUses] = useState<string[]>(current?.uses ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const others = drawers.filter((_, i) => i !== index)
  const suggested = `${(profile.notes ?? profile.home ?? '~').replace(/\/+$/, '')}/drawers/${drawerSlug(name.trim() || 'drawer')}`

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !confirming && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, confirming])

  async function choose(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      setLogo(await putLogo(await makeLogo(file)))
      setError(null)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  async function useSuggested() {
    if (!name.trim()) return setError('Name the drawer first')
    try {
      setFolder((await api.drawerFolder(profileId, name.trim())).folder)
      setError(null)
    } catch (err) {
      setError(message(err))
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return setError('A drawer needs a name')
    if (others.some((d) => d.name.toLowerCase() === n.toLowerCase())) return setError(`There is already a drawer called ${n}`)
    if (folder.trim() && !/^(~|\/)/.test(folder.trim())) return setError('The shared folder must start with ~ or /')
    // A new drawer comes after the others; a profile without drawers gets its headings moved into the first.
    const at = index ?? drawers.length
    const ops: Op[] = index === null ? [{ op: 'addDrawer', name: n }] : []
    if (index !== null && n !== current?.name) ops.push({ op: 'setDrawer', drawer: at, field: 'name', value: n })
    if (logo !== (current?.logo ?? '')) ops.push({ op: 'setDrawer', drawer: at, field: 'logo', value: logo })
    if (folder.trim() !== (current?.folder ?? '')) ops.push({ op: 'setDrawer', drawer: at, field: 'folder', value: folder.trim() })
    const keep = uses.filter((u) => others.some((d) => d.name === u))
    if (keep.join('\n') !== (current?.uses ?? []).join('\n')) ops.push({ op: 'setDrawer', drawer: at, field: 'uses', value: keep })
    if (!ops.length) return onClose()
    if (await run(ops, index === null ? `New drawer ${n}` : `Drawer ${n} saved`)) {
      onShow(n)
      onClose()
    }
  }

  async function remove() {
    setConfirming(false)
    if (index === null || !current) return
    if (await run([{ op: 'deleteDrawer', drawer: index }], `Deleted drawer ${current.name}`)) {
      onDeleted()
      onClose()
    }
  }

  const entries = current?.sections.reduce((n, s) => n + s.items.length, 0) ?? 0

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog drawer-dialog" role="dialog" aria-label={index === null ? 'New drawer' : 'Drawer settings'} onSubmit={save}>
        <header>
          {index === null ? 'New drawer' : 'Drawer settings'}
          <small>{profileId}.yaml · saved in the file, comments kept</small>
        </header>
        <div className="body">
          {index === null && !hasDrawers(profile) && (
            <p className="hint">Your current headings become the first drawer, {profile.name}. You can rename it.</p>
          )}
          <label className="field">
            <span>Name</span>
            <input name="drawerName" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} />
          </label>
          <div className="field">
            <span>Logo</span>
            <div className="logo-row">
              <DrawerLogo name={name.trim() || '?'} logo={logo || undefined} size={64} />
              <div>
                <span className="hint">A square picture, scaled to 64 × 64. Without one, the drawer's initials.</span>
                <div className="logo-actions">
                  <button type="button" className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                    <ImagePlus size={13} /> Choose picture…
                  </button>
                  {logo && (
                    <button type="button" className="btn ghost" onClick={() => setLogo('')}>
                      Remove
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" hidden aria-label="Logo picture" onChange={(e) => void choose(e.target.files?.[0])} />
              </div>
            </div>
          </div>
          <label className="field">
            <span>Shared folder</span>
            <input className="mono" name="drawerFolder" value={folder} placeholder="None" onChange={(e) => setFolder(e.target.value)} />
            {folder.trim() ? (
              <span className="hint">Other drawers can use it; it shows under Shared, and claude chats here can read it.</span>
            ) : (
              <span className="hint">
                No folder yet.{' '}
                <button type="button" className="link-btn" onClick={() => void useSuggested()}>
                  Use {suggested}
                </button>
              </span>
            )}
          </label>
          {others.length > 0 && (
            <fieldset className="field uses">
              <legend>Uses shared folders from</legend>
              {others.map((d) => (
                <label key={d.name} className="check">
                  <input type="checkbox" checked={uses.includes(d.name)} onChange={(e) => setUses((u) => (e.target.checked ? [...u, d.name] : u.filter((x) => x !== d.name)))} />
                  {d.name}
                  <span className="mono uses-path">{d.folder ?? 'no folder'}</span>
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <footer>
          {index !== null && (
            <button type="button" className="btn ghost danger" disabled={drawers.length <= 1} title={drawers.length <= 1 ? 'A profile keeps at least one drawer' : undefined} onClick={() => setConfirming(true)}>
              <Trash2 size={13} /> Delete drawer…
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {index === null ? 'Add drawer' : 'Save'}
          </button>
        </footer>
      </form>
      {confirming && current && (
        <ConfirmDialog title={`Delete ${current.name}?`} action="Delete" onCancel={() => setConfirming(false)} onConfirm={() => void remove()}>
          Its {current.sections.length} {current.sections.length === 1 ? 'heading' : 'headings'} and {entries} {entries === 1 ? 'entry' : 'entries'} leave the switcher; the drawer’s page and the folders on disk stay. Undo brings it back.
        </ConfirmDialog>
      )}
    </div>
  )
}
