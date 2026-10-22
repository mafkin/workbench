// Ctrl+K: go anywhere or do something. Entries, steps, notes, context folders,
// chats, pages and actions, matched as you type; recent picks come first.
import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocal } from '../lib/local.ts'
import { cx } from '../lib/nav.ts'
import { KIND_LABEL, rank, type SwitchItem } from '../lib/switcher.ts'

export function QuickSwitcher({ items, onClose }: { items: SwitchItem[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const [recent, setRecent] = useLocal<string[]>('switcherRecent', [])
  const list = useMemo(() => rank(items, query, recent), [items, query, recent])
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => setAt(0), [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const pick = (item: SwitchItem) => {
    setRecent((r) => [item.id, ...r.filter((id) => id !== item.id)].slice(0, 20))
    onClose()
    item.run()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setAt((i) => Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (list[at]) pick(list[at])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="scrim switcher-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-label="Quick switcher">
        <label className="switcher-input">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go to a project, step, note or chat, or do something…"
            aria-label="Quick switcher"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-list"
          />
          <span className="kbd">Esc</span>
        </label>
        {list.length === 0 ? (
          <p className="switcher-empty">Nothing matches.</p>
        ) : (
          <ul className="switcher-list" id="switcher-list" role="listbox" ref={listRef}>
            {list.map((item, i) => (
              <li
                key={item.id}
                role="option"
                aria-selected={i === at}
                className={cx('switcher-row', i === at && 'active', item.kind === 'action' && 'action')}
                onPointerMove={() => i !== at && setAt(i)}
                onClick={() => pick(item)}
              >
                <span className="label">{item.label}</span>
                {item.detail && <span className="detail">{item.detail}</span>}
                <span className="kind">{KIND_LABEL[item.kind]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
