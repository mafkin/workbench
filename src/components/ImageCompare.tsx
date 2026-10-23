// Two images compared: side by side, or one over the other with a slider
// between them. Fit or actual size applies to both.
import { useEffect, useState } from 'react'
import type { FileEntry } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'

type Mode = 'side' | 'slider'

export function ImageCompare({ a, b }: { a: FileEntry; b: FileEntry }) {
  const { profile } = useNotes()
  const [urls, setUrls] = useState<[string, string] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('slider')
  const [split, setSplit] = useState(50)
  const [actual, setActual] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([api.fileTicket(profile, a.path), api.fileTicket(profile, b.path)]).then(
      ([x, y]) => live && setUrls([x.url, y.url]),
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [profile, a.path, b.path])

  if (error) return <p className="preview-note">{error}</p>
  if (!urls) return <div className="preview-loading" />
  return (
    <div className={cx('compare', actual && 'actual')}>
      <div className="compare-bar" role="toolbar" aria-label="Compare">
        <div className="segmented" role="radiogroup" aria-label="Compare how">
          <button role="radio" aria-checked={mode === 'slider'} className={cx(mode === 'slider' && 'active')} onClick={() => setMode('slider')}>
            Slider
          </button>
          <button role="radio" aria-checked={mode === 'side'} className={cx(mode === 'side' && 'active')} onClick={() => setMode('side')}>
            Side by side
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={actual} onChange={(e) => setActual(e.target.checked)} /> Actual size
        </label>
      </div>
      {mode === 'side' ? (
        <div className="compare-side">
          {[a, b].map((e, i) => (
            <figure key={e.path}>
              <img src={urls[i]} alt={e.name} />
              <figcaption>{e.name}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <>
          <div className="compare-stack">
            <img src={urls[0]} alt={a.name} />
            <img src={urls[1]} alt={b.name} className="over" style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
            <span className="compare-line" style={{ left: `${split}%` }} />
          </div>
          <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label={`Between ${a.name} and ${b.name}`} className="compare-range" />
          <div className="compare-names">
            <span>{a.name}</span>
            <span>{b.name}</span>
          </div>
        </>
      )}
    </div>
  )
}
