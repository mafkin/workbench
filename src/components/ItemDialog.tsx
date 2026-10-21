import { useEffect, useRef, useState } from 'react'
import { ITEM_TYPES, NavItem, type ItemInput, type ItemType } from '../../shared/config-schema.ts'
import { stat } from '../lib/api.ts'
import { cx, type DialogState } from '../lib/nav.ts'
import { EntryIcon, isIconName, TYPE_ICON, TYPE_LABEL } from './EntryIcon.tsx'

const HINTS: Record<ItemType, string> = {
  folder: 'Opens in the file browser (part 3). For now: Open in Files.',
  note: 'A Markdown file. Opens formatted in the main pane; Edit (Ctrl+E) to change it.',
  daily: "Today's note in the notes folder, made from a template the first time.",
  project: 'A project card id. Cards arrive in part 4.',
  link: 'Opens in your default browser.',
  launch: 'Starts a program directly, without a shell.',
  group: 'Holds entries one level deep under this heading.',
}

interface Props {
  dialog: Exclude<DialogState, { mode: 'note' }>
  onClose: () => void
  onSubmit: (item: ItemInput) => Promise<boolean>
}

export function ItemDialog({ dialog, onClose, onSubmit }: Props) {
  const initial = dialog.mode === 'edit' ? dialog.item : undefined
  const insideGroup = dialog.mode === 'edit' ? dialog.at.group !== undefined : dialog.list.group !== undefined
  const lockedGroup = initial?.type === 'group' && initial.items.length > 0

  const [type, setType] = useState<ItemType>(initial?.type ?? (dialog.mode === 'add' ? (dialog.presetType ?? 'folder') : 'folder'))
  const [label, setLabel] = useState(initial?.label ?? '')
  const [path, setPath] = useState(initial && 'path' in initial ? initial.path : '')
  const [url, setUrl] = useState(initial?.type === 'link' ? initial.url : '')
  const [project, setProject] = useState(initial?.type === 'project' ? initial.project : '')
  const [command, setCommand] = useState(initial?.type === 'launch' ? initial.command : '')
  const [argsText, setArgsText] = useState(initial?.type === 'launch' ? initial.args.join('\n') : '')
  const [cwd, setCwd] = useState(initial?.type === 'launch' ? (initial.cwd ?? '') : '')
  const [folder, setFolder] = useState(initial?.type === 'daily' ? (initial.folder ?? '') : '')
  const [template, setTemplate] = useState(initial?.type === 'daily' ? (initial.template ?? '') : '')
  const [icon, setIcon] = useState(initial?.icon ?? '')
  const [error, setError] = useState<{ field?: string; message: string } | null>(null)
  const [pathStatus, setPathStatus] = useState<{ exists: boolean; kind: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const labelRef = useRef<HTMLInputElement>(null)

  useEffect(() => labelRef.current?.focus(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Warn, without blocking, when the path does not exist or is the wrong kind.
  useEffect(() => {
    setPathStatus(null)
    if ((type !== 'folder' && type !== 'note') || !path.trim()) return
    const t = setTimeout(() => {
      stat(path.trim()).then(setPathStatus, () => setPathStatus(null))
    }, 250)
    return () => clearTimeout(t)
  }, [type, path])

  function build(): ItemInput {
    const base = { label: label.trim(), icon: icon.trim() || undefined }
    switch (type) {
      case 'folder':
      case 'note':
        return { ...base, type, path: path.trim() }
      case 'link':
        return { ...base, type, url: url.trim() }
      case 'daily':
        return { ...base, type, folder: folder.trim() || undefined, template: template.trim() || undefined }
      case 'project':
        return { ...base, type, project: project.trim() }
      case 'launch':
        return {
          ...base,
          type,
          command: command.trim(),
          args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
          cwd: cwd.trim() || undefined,
        }
      case 'group':
        return { ...base, type, items: [] }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const item = build()
    const parsed = NavItem.safeParse(item)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      setError({ field: String(issue?.path[0] ?? ''), message: issue?.message ?? 'Invalid entry' })
      return
    }
    setBusy(true)
    const ok = await onSubmit(item)
    setBusy(false)
    if (ok) onClose()
  }

  // Fill an empty label from the last path segment.
  function suggestLabel() {
    if (label.trim() || !path.trim()) return
    const name = path.trim().replace(/\/+$/, '').split('/').pop() ?? ''
    if (name && name !== '~') setLabel(type === 'note' ? name.replace(/\.md$/i, '') : name)
  }

  const fieldError = (name: string) => (error?.field === name ? <span className="err">{error.message}</span> : null)

  const pathHint = () => {
    if (!pathStatus) return null
    if (!pathStatus.exists) return <span className="hint" style={{ color: 'var(--warn)' }}>Not found on disk (you can still save it)</span>
    if (type === 'folder' && pathStatus.kind !== 'dir') return <span className="hint" style={{ color: 'var(--warn)' }}>This is a file, not a folder</span>
    if (type === 'note' && pathStatus.kind !== 'file') return <span className="hint" style={{ color: 'var(--warn)' }}>This is a folder, not a file</span>
    return <span className="hint" style={{ color: 'var(--ok)' }}>Found</span>
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-label={dialog.mode === 'add' ? 'Add entry' : 'Edit entry'}>
        <header>
          {dialog.mode === 'add' ? 'Add entry' : 'Edit entry'}
          <small>{dialog.context}</small>
        </header>
        <div className="body">
          <div className="type-picker" role="radiogroup" aria-label="Type">
            {ITEM_TYPES.map((t) => {
              const Icon = TYPE_ICON[t]
              const disabled = (t === 'group' && insideGroup) || (lockedGroup && t !== 'group')
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={type === t}
                  className={cx(type === t && 'active')}
                  disabled={disabled}
                  title={disabled ? (lockedGroup ? 'Empty the group first' : 'Groups are one level deep') : TYPE_LABEL[t]}
                  onClick={() => {
                    setType(t)
                    setError(null)
                  }}
                >
                  <Icon size={15} />
                  {TYPE_LABEL[t]}
                </button>
              )
            })}
          </div>
          <span className="hint" style={{ color: 'var(--faint)', fontSize: 11, marginTop: -6 }}>
            {HINTS[type]}
          </span>

          <label className="field">
            <span>Label</span>
            <input ref={labelRef} value={label} onChange={(e) => setLabel(e.target.value)} name="label" />
            {fieldError('label')}
          </label>

          {(type === 'folder' || type === 'note') && (
            <label className="field">
              <span>{type === 'folder' ? 'Folder' : 'File'}</span>
              <input
                className="mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onBlur={suggestLabel}
                placeholder={type === 'folder' ? '~/Projects/name' : '~/notes/file.md'}
                name="path"
              />
              {fieldError('path') ?? pathHint()}
            </label>
          )}

          {type === 'daily' && (
            <>
              <label className="field">
                <span>Folder (optional)</span>
                <input className="mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="daily" name="folder" />
                <span className="hint">Inside the notes folder. Each day is YYYY-MM-DD.md.</span>
              </label>
              <label className="field">
                <span>Template (optional)</span>
                <input className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="templates/daily.md" name="template" />
                <span className="hint">{'Inside the notes folder. {{date}} and {{title}} are filled in.'}</span>
              </label>
            </>
          )}

          {type === 'link' && (
            <label className="field">
              <span>URL</span>
              <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" name="url" />
              {fieldError('url')}
            </label>
          )}

          {type === 'project' && (
            <label className="field">
              <span>Project id</span>
              <input className="mono" value={project} onChange={(e) => setProject(e.target.value)} name="project" />
              {fieldError('project')}
            </label>
          )}

          {type === 'launch' && (
            <>
              <label className="field">
                <span>Command</span>
                <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="godot" name="command" />
                {fieldError('command')}
              </label>
              <label className="field">
                <span>Arguments</span>
                <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={'--path\n~/Projects/tuohi'} name="args" />
                <span className="hint">One argument per line. A leading ~ is expanded.</span>
              </label>
              <label className="field">
                <span>Working folder (optional)</span>
                <input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} name="cwd" />
              </label>
            </>
          )}

          <label className="field">
            <span>Icon (optional)</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-grid', placeItems: 'center', width: 30 }}>
                <EntryIcon type={type} icon={icon.trim()} size={16} />
              </span>
              <input className="mono" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="lucide name, e.g. rocket" name="icon" />
            </div>
            {icon.trim() && !isIconName(icon.trim()) ? (
              <span className="hint" style={{ color: 'var(--warn)' }}>Not a lucide icon name; the type icon is used</span>
            ) : (
              <span className="hint">Any name from lucide.dev/icons</span>
            )}
          </label>
          {error && !error.field && <span className="err">{error.message}</span>}
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {dialog.mode === 'add' ? 'Add' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}
