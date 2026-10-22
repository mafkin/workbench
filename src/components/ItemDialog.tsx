import { useEffect, useRef, useState } from 'react'
import { chatProgram, ITEM_TYPES, NavItem, StepItem, STEP_TYPES, stepPath, type AnyType, type ItemInput } from '../../shared/config-schema.ts'
import { stat } from '../lib/api.ts'
import { cx, type DialogState } from '../lib/nav.ts'
import { EntryIcon, isIconName, TYPE_ICON, TYPE_LABEL } from './EntryIcon.tsx'

// For a workflow step, paths are inside the project.
const STEP_HINTS: Partial<Record<AnyType, string>> = {
  folder: 'A folder in the project, like assets. It opens in the browser.',
  note: 'A note in the project, like docs/design.md. It opens in place, with Edit.',
  report: 'An HTML file in the project, like reports/index.html. Shown in the tab, with the files next to it.',
  file: 'One file in the project, like renders/latest.png. Shown large in the tab.',
  chat: 'Claude (or your shell) in a tab, in the project folder or a folder inside it. Keeps running when you close the window.',
  launch: 'Runs in the project folder; arguments can be paths inside it.',
  link: 'A web address. The tab opens it in your browser.',
}

const HINTS: Record<AnyType, string> = {
  folder: 'A project: its card, workflow tabs and files.',
  note: 'A Markdown file. Opens formatted in the main pane; Edit (Ctrl+E) to change it.',
  report: '',
  file: '',
  daily: "Today's note in the notes folder, made from a template the first time.",
  chat: 'Claude (or your shell) in a terminal in the app. Keeps running when you close the window.',
  link: 'Opens in your default browser.',
  launch: 'Starts a program directly, without a shell.',
  group: 'Holds entries one level deep under this heading.',
}

const PATH_TYPES: AnyType[] = ['folder', 'note', 'report', 'file']

interface Props {
  dialog: Exclude<DialogState, { mode: 'note' }>
  /** The profile's agent profiles, offered for a chat. */
  agents: string[]
  onClose: () => void
  onSubmit: (item: ItemInput) => Promise<boolean>
}

export function ItemDialog({ dialog, agents, onClose, onSubmit }: Props) {
  const step = dialog.mode === 'step' ? dialog : null
  const initial = dialog.mode === 'edit' ? dialog.item : step?.item
  const adding = dialog.mode === 'add' || (step !== null && step.index === undefined)
  const insideGroup = dialog.mode === 'edit' ? dialog.at.group !== undefined : dialog.mode === 'add' && dialog.list.group !== undefined
  const lockedGroup = initial?.type === 'group' && initial.items.length > 0
  const types: readonly AnyType[] = step ? STEP_TYPES : ITEM_TYPES
  const noun = step ? 'step' : 'entry'

  const [type, setType] = useState<AnyType>(initial?.type ?? (dialog.mode === 'add' ? (dialog.presetType ?? 'folder') : 'folder'))
  const [label, setLabel] = useState(initial?.label ?? '')
  const [path, setPath] = useState(initial && 'path' in initial ? (initial.path ?? '') : '')
  const [url, setUrl] = useState(initial?.type === 'link' ? initial.url : '')
  const [command, setCommand] = useState(initial?.type === 'launch' ? initial.command : '')
  const [argsText, setArgsText] = useState(initial?.type === 'launch' || initial?.type === 'chat' ? initial.args.join('\n') : '')
  // claude, shell or an agent profile's name.
  const [agent, setAgent] = useState<string>(initial?.type === 'chat' ? (initial.agent ?? 'claude') : 'claude')
  const shell = chatProgram(agent) === 'shell'
  // A name the file has but no agent profile matches still shows, so saving keeps it.
  const agentChoices = ['claude', 'shell', ...agents, ...(['claude', 'shell', ...agents].includes(agent) ? [] : [agent])]
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
    if ((!PATH_TYPES.includes(type) && type !== 'chat') || !path.trim()) return
    const t = setTimeout(() => {
      stat(step ? stepPath(step.base, path.trim()) : path.trim()).then(setPathStatus, () => setPathStatus(null))
    }, 250)
    return () => clearTimeout(t)
  }, [type, path])

  function build(): ItemInput {
    const base = { label: label.trim(), icon: icon.trim() || undefined }
    switch (type) {
      case 'folder':
      case 'note':
      case 'report':
      case 'file':
        return { ...base, type, path: path.trim() }
      case 'link':
        return { ...base, type, url: url.trim() }
      case 'daily':
        return { ...base, type, folder: folder.trim() || undefined, template: template.trim() || undefined }
      case 'launch':
        return {
          ...base,
          type,
          command: command.trim(),
          args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
          cwd: cwd.trim() || undefined,
        }
      case 'chat':
        return {
          ...base,
          type,
          agent: agent === 'claude' ? undefined : agent,
          path: path.trim() || undefined,
          args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
        }
      case 'group':
        return { ...base, type, items: [] }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const item = build()
    const parsed = (step ? StepItem : NavItem).safeParse(item)
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
    const wantsDir = type === 'folder' || type === 'chat'
    if (wantsDir && pathStatus.kind !== 'dir') return <span className="hint" style={{ color: 'var(--warn)' }}>This is a file, not a folder</span>
    if (!wantsDir && pathStatus.kind !== 'file') return <span className="hint" style={{ color: 'var(--warn)' }}>This is a folder, not a file</span>
    return <span className="hint" style={{ color: 'var(--ok)' }}>Found</span>
  }

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} aria-label={`${adding ? 'Add' : 'Edit'} ${noun}`}>
        <header>
          {adding ? 'Add' : 'Edit'} {noun}
          <small>{dialog.context}</small>
        </header>
        <div className="body">
          <div className="type-picker" role="radiogroup" aria-label="Type" style={{ gridTemplateColumns: `repeat(${types.length}, 1fr)` }}>
            {types.map((t) => {
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
            {(step && STEP_HINTS[type]) || HINTS[type]}
          </span>

          <label className="field">
            <span>Label</span>
            <input ref={labelRef} value={label} onChange={(e) => setLabel(e.target.value)} name="label" />
            {fieldError('label')}
          </label>

          {PATH_TYPES.includes(type) && (
            <label className="field">
              <span>{type === 'folder' ? 'Folder' : 'File'}</span>
              <input
                className="mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onBlur={suggestLabel}
                placeholder={
                  step
                    ? { folder: 'assets', note: 'docs/design.md', report: 'reports/index.html', file: 'renders/latest.png' }[type as string]
                    : type === 'folder'
                      ? '~/Projects/name'
                      : '~/notes/file.md'
                }
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

          {type === 'chat' && (
            <>
              <div className="field">
                <span>Agent</span>
                <div className="segmented wrap" role="radiogroup" aria-label="Agent">
                  {agentChoices.map((a) => (
                    <button key={a} type="button" role="radio" aria-checked={agent === a} className={cx(agent === a && 'active')} onClick={() => setAgent(a)}>
                      <EntryIcon type="chat" agent={chatProgram(a)} size={14} />
                      {a === 'claude' ? 'Claude' : a === 'shell' ? 'Shell' : a}
                    </button>
                  ))}
                </div>
                {agents.length === 0 && <span className="hint">Agent profiles you add (New chat ▾ › Agent profiles…) show up here.</span>}
              </div>
              <label className="field">
                <span>Folder (optional)</span>
                <input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder={step ? 'docs' : '~'} name="path" />
                {fieldError('path') ?? pathHint() ?? <span className="hint">{step ? 'Inside the project; empty is the project folder.' : 'Empty is your home folder.'}</span>}
              </label>
              <label className="field">
                <span>Arguments (optional)</span>
                <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={shell ? '' : '--model\nopus'} name="args" />
                <span className="hint">One per line, added to {shell ? 'the shell' : 'claude'}.</span>
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
                <EntryIcon type={type} icon={icon.trim()} agent={chatProgram(agent)} size={16} />
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
            {adding ? 'Add' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}
