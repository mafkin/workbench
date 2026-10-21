import { useCallback, useRef, useState } from 'react'
import { cx } from '../lib/nav.ts'

export interface ToastInput {
  message: string
  kind?: 'info' | 'error'
  action?: { label: string; run: () => void }
}

interface Toast extends ToastInput {
  id: number
}

export function useToasts() {
  const [list, setList] = useState<Toast[]>([])
  const next = useRef(1)
  const dismiss = useCallback((id: number) => setList((l) => l.filter((t) => t.id !== id)), [])
  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++
      setList((l) => [...l.slice(-3), { ...t, id }])
      setTimeout(() => dismiss(id), t.action ? 8000 : t.kind === 'error' ? 6000 : 3500)
    },
    [dismiss],
  )
  return { list, push, dismiss }
}

export function Toasts({ list, dismiss }: { list: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={cx('toast', t.kind === 'error' && 'error')}>
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                dismiss(t.id)
                t.action!.run()
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
