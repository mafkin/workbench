// Theme and background for the active profile. Each choice is written to the
// profile's YAML at once (`theme:`, `background:`), with Undo in the toast.
import { ImagePlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { themeOf, type Op, type Profile } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { THEME_LIST, themeById } from '../lib/themes.ts'

interface Props {
  profile: Profile
  profileId: string
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  /** The picture `background:` names is not in the folder (the theme's own shows). */
  pictureMissing: boolean
  onClose: () => void
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function LookPanel({ profile, profileId, run, pictureMissing, onClose }: Props) {
  const current = themeOf(profile.theme)
  const theme = themeById(current)
  const background = profile.background ?? 'theme'
  const [pictures, setPictures] = useState<string[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const urls = useRef<string[]>([])

  const refresh = () =>
    api.listBackgrounds().then(
      (names) => {
        setPictures(names)
        for (const n of names) {
          if (thumbs[n]) continue
          void api.backgroundImage(n).then((blob) => {
            const url = URL.createObjectURL(blob)
            urls.current.push(url)
            setThumbs((t) => ({ ...t, [n]: url }))
          }, () => {})
        }
      },
      () => setPictures([]),
    )

  useEffect(() => {
    void refresh()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const u of urls.current) URL.revokeObjectURL(u)
    }
  }, [])

  const setTheme = (id: string, name: string) => void run([{ op: 'setProfileField', key: 'theme', value: id }], `Theme: ${name}`)
  // The theme's own background is the default, written by leaving the key out.
  const setBackground = (value: string, label: string) =>
    run([{ op: 'setProfileField', key: 'background', value: value === 'theme' ? '' : value }], `Background: ${label}`)

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!path.trim()) return
    setBusy(true)
    setError(null)
    try {
      const { name } = await api.addBackground(profileId, path.trim())
      await setBackground(name, name)
      setPath('')
      await refresh()
    } catch (err) {
      setError(message(err))
    }
    setBusy(false)
  }

  async function remove(name: string) {
    try {
      await api.deleteBackground(name)
    } catch (err) {
      return setError(message(err))
    }
    if (background === name) await setBackground('theme', "the theme's own")
    setPictures((p) => p.filter((n) => n !== name))
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog look-dialog" role="dialog" aria-label="Theme and background">
        <header>
          Theme and background
          <small>{profile.name} · saved in its YAML; the accent stays the profile's own</small>
        </header>
        <div className="body">
          <h3 className="section-label">Theme</h3>
          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEME_LIST.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={current === t.id}
                aria-label={t.name}
                className={cx('theme-card', current === t.id && 'active')}
                style={{ background: t.backdrop, color: t.colors.textStrong }}
                onClick={() => setTheme(t.id, t.name)}
              >
                <span className="mini" style={{ background: t.colors.panel, borderColor: t.colors.borderStrong }}>
                  <span className="mini-line" style={{ background: t.colors.text }} />
                  <span className="mini-line short" style={{ background: t.colors.muted }} />
                  <span className="mini-dot" />
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-note" style={{ color: t.colors.muted }}>
                  {t.note}
                </span>
              </button>
            ))}
          </div>
          {profile.theme && profile.theme !== current && <span className="hint warn">theme: {profile.theme} is not one of these; Slate shows instead.</span>}

          <h3 className="section-label">Background</h3>
          <div className="bg-options" role="radiogroup" aria-label="Background">
            <button role="radio" aria-checked={background === 'theme'} className="bg-option" style={{ background: theme.backdrop }} onClick={() => void setBackground('theme', "the theme's own")}>
              <span>Theme's own</span>
            </button>
            <button role="radio" aria-checked={background === 'none'} className="bg-option" style={{ background: theme.colors.bg }} onClick={() => void setBackground('none', 'none')}>
              <span>None</span>
            </button>
            {pictures.map((n) => (
              <div key={n} className="bg-picture">
                <button
                  role="radio"
                  aria-checked={background === n}
                  aria-label={n}
                  className="bg-option"
                  style={thumbs[n] ? { backgroundImage: `url("${thumbs[n]}")` } : undefined}
                  onClick={() => void setBackground(n, n)}
                >
                  <span>{n}</span>
                </button>
                <button className="bg-delete" aria-label={`Delete ${n}`} title="Delete from the backgrounds folder" onClick={() => void remove(n)}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          {pictureMissing && <span className="hint warn">background: {background} is not in the backgrounds folder; the theme's own shows instead.</span>}
          <form className="bg-add" onSubmit={add}>
            <input className="mono" name="picture" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/Pictures/lake.jpg" aria-label="Picture path" />
            <button type="submit" className="btn" disabled={busy || !path.trim()}>
              <ImagePlus size={14} /> Add picture
            </button>
          </form>
          {error ? (
            <span className="err">{error}</span>
          ) : (
            <span className="hint">From this profile's folders (jpg, png, webp, avif or gif). Or right-click a picture in the file browser: Use as background. A copy is kept in Workbench's config folder.</span>
          )}
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
