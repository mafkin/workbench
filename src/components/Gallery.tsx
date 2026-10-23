// The file browser's gallery view: one folder's entries as tiles with
// thumbnails. Selection, keys, menus and drag and drop belong to the browser
// around it; this draws the tiles (only the rows in view) and tells it how many
// fit in a row, for the arrow keys.
import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../shared/config-schema.ts'
import { previewKind } from '../lib/files.ts'
import { cx } from '../lib/nav.ts'
import { useThumb } from '../lib/thumbs.ts'
import { FileIcon } from './FileIcon.tsx'

const GAP = 10
/** The name under the thumbnail. */
const LABEL = 34

/** Kinds worth asking the cache about; anything else is just its icon. */
const THUMBED = new Set(['image', 'video', 'audio', 'model', 'blend', 'folder'])

interface Props {
  profile: string
  entries: FileEntry[]
  selected: string[]
  size: number
  /** The selected entry, kept in view. */
  current: string | null
  dropTarget: string | null
  onCols: (cols: number) => void
  tileProps: (entry: FileEntry) => React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
  label: (entry: FileEntry) => React.ReactNode
}

/** The nearest scrolling ancestor; the page itself when there is none. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return document.scrollingElement as HTMLElement
}

export function Gallery({ profile, entries, selected, size, current, dropTarget, onCols, tileProps, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 12])
  const cols = Math.max(1, Math.floor((width + GAP) / (size + GAP)))
  const rowH = size + LABEL + GAP
  const rowCount = Math.ceil(entries.length / cols)

  useEffect(() => {
    onCols(cols)
  }, [cols])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Only the rows in view (and two either side) are drawn, so thumbnails are asked for as they come into view.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scroller = scrollerOf(el)
    const update = () => {
      const view = scroller.getBoundingClientRect()
      const offset = view.top - el.getBoundingClientRect().top
      const first = Math.max(0, Math.floor(offset / rowH) - 2)
      setRange([first, first + Math.ceil(view.height / rowH) + 4])
    }
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      scroller.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [rowH, rowCount])

  // Keep the selected tile in view (keys move it a row at a time).
  useEffect(() => {
    const el = ref.current
    if (!current || !el) return
    const i = entries.findIndex((e) => e.path === current)
    if (i < 0) return
    const scroller = scrollerOf(el)
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + Math.floor(i / cols) * rowH
    if (top < 0) scroller.scrollTop += top - GAP
    else if (top + rowH > scroller.clientHeight) scroller.scrollTop += top + rowH - scroller.clientHeight + GAP
  }, [current, cols])

  const [first, last] = [Math.min(range[0], rowCount), Math.min(range[1], rowCount)]
  const shown = entries.slice(first * cols, last * cols)

  return (
    <div ref={ref} className="gallery" style={{ '--tile': `${size}px`, '--gap': `${GAP}px`, paddingTop: first * rowH, paddingBottom: (rowCount - last) * rowH } as React.CSSProperties}>
      {shown.map((entry) => (
        <Tile key={entry.path} profile={profile} entry={entry} size={size} selected={selected.includes(entry.path)} dropInto={dropTarget === entry.path} props={tileProps(entry)} label={label(entry)} />
      ))}
    </div>
  )
}

function Tile({
  profile,
  entry,
  size,
  selected,
  dropInto,
  props,
  label,
}: {
  profile: string
  entry: FileEntry
  size: number
  selected: boolean
  dropInto: boolean
  props: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
  label: React.ReactNode
}) {
  const kind = previewKind(entry)
  const thumb = useThumb(profile, entry, THUMBED.has(kind))
  const ext = entry.kind === 'file' && entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toUpperCase() : ''
  return (
    <div
      role="option"
      aria-label={entry.name}
      aria-selected={selected}
      data-path={entry.path}
      className={cx('tile', selected && 'selected', dropInto && 'drop-into', entry.ignored && 'ignored', entry.hidden && 'hidden-file', `k-${kind}`)}
      title={entry.name}
      {...props}
    >
      <div className={cx('tile-thumb', thumb.status === 'ok' && 'has-thumb')}>
        {thumb.status === 'ok' ? (
          <img
            src={thumb.url}
            alt=""
            draggable={false}
            // A tiny image (pixel art, a small icon) is scaled up crisp rather than blurred.
            onLoad={(e) => e.currentTarget.classList.toggle('tiny', Math.max(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight) * 2 < size)}
          />
        ) : (
          <FileIcon entry={entry} size={Math.round(size / 3)} />
        )}
        {(kind === 'model' || kind === 'blend' || kind === 'video' || kind === 'audio') && ext && <span className="tile-badge">{ext}</span>}
        {thumb.status === 'loading' && THUMBED.has(kind) && kind !== 'folder' && <span className="tile-wait" />}
      </div>
      <div className="tile-name">{label}</div>
    </div>
  )
}
