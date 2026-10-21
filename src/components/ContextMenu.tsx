import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cx, type MenuState } from '../lib/nav.ts'

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.min(menu.x, window.innerWidth - width - 8),
      top: Math.min(menu.y, window.innerHeight - height - 8),
    })
  }, [menu.x, menu.y])

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof PointerEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', key)
    }
  }, [onClose])

  return (
    <div ref={ref} className="menu" style={pos} role="menu">
      {menu.entries.map((e, i) =>
        e === 'sep' ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={cx(e.danger && 'danger')}
            onClick={() => {
              onClose()
              e.run()
            }}
          >
            {e.icon}
            {e.label}
          </button>
        ),
      )}
    </div>
  )
}
