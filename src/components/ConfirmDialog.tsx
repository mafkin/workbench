import { useEffect, useRef } from 'react'

/** A yes-or-no question in the app's dialog style; Enter confirms, Esc cancels. */
export function ConfirmDialog({
  title,
  action,
  children,
  onConfirm,
  onCancel,
}: {
  title: string
  action: string
  children: React.ReactNode
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirm = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    confirm.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog confirm" role="alertdialog" aria-label={title}>
        <header>{title}</header>
        <div className="body">
          <p>{children}</p>
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary danger" ref={confirm} onClick={onConfirm}>
            {action}
          </button>
        </footer>
      </div>
    </div>
  )
}
