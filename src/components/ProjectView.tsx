// A project: a folder entry with its card (category, status, pin, description)
// and its workflow steps as tabs. "All files" is the project folder; a folder
// step shows its folder in the browser, a note step its note in place, a report
// its HTML page, a file step one file large, and launcher and link steps open
// outside. Steps are the project's own `steps:` or, until it has any, the
// profile's `workflow:`.
import { ExternalLink, FolderOpen, Pencil, Pin, Plus, RefreshCw, RotateCcw, Share2, Tag, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  categoriesOf,
  categoryColor,
  expandHome,
  folderRoots,
  normalizePath,
  STATUSES,
  stepPath,
  stepsOf,
  type CARD_FIELDS,
  type ItemAddr,
  type NavItem,
  type Op,
  type Profile,
  type Status,
  type StepItem,
} from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { nameOf, parentOf, previewKind } from '../lib/files.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type DialogState, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { ContextMenu } from './ContextMenu.tsx'
import { EntryIcon } from './EntryIcon.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { MediaPreview, TextPreview } from './FilePreview.tsx'
import { NoteView } from './NoteView.tsx'
import type { ToastInput } from './Toast.tsx'

/** What a project page needs from the app. */
export interface ProjectActions {
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  openDialog: (d: DialogState) => void
  /** Start a launcher step, or open a link step in the browser. */
  launchStep: (addr: ItemAddr, index: number, label: string, kind: 'launch' | 'link') => void
  rememberStep: (addr: ItemAddr, label: string) => void
}

export const STATUS_LABEL: Record<Status, string> = { active: 'Active', paused: 'Paused', done: 'Done', archived: 'Archived' }

type CardField = (typeof CARD_FIELDS)[number]

/** Steps that open outside the app rather than in a tab. */
const opensOutside = (s: StepItem) => s.type === 'launch' || s.type === 'link'

interface Props {
  addr: ItemAddr
  item: Extract<NavItem, { type: 'folder' }>
  kicker: string
  profile: Profile
  profileId: string
  home: string
  actions: ProjectActions
  openFolder: (path: string) => void
  toast: (t: ToastInput) => void
  /** The open step's label, for the crumbs; null for All files. */
  onTab: (label: string | null) => void
}

const describe = (s: StepItem) => (s.type === 'launch' ? [s.command, ...s.args].join(' ') : s.type === 'link' ? s.url : s.path)
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ProjectView({ addr, item, kicker, profile, profileId, home, actions, openFolder, toast, onTab }: Props) {
  const steps = stepsOf(profile, item)
  const own = item.steps !== undefined
  const [tabs, setTabs] = useLocal<Record<string, string>>('projectTab', {})
  const tabKey = `${profileId}|${item.path}`
  const active = steps.find((s) => s.label === tabs[tabKey] && !opensOutside(s)) ?? null
  const tabId = active?.label ?? ''
  const [browse, setBrowse] = useState<{ tab: string; top: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<'description' | 'category' | null>(null)
  const dragging = useRef<number | null>(null)
  const status = item.status ?? 'active'

  useEffect(() => onTab(active?.label ?? null), [active?.label])

  const norm = (p: string) => normalizePath(expandHome(p, home))
  const within = (p: string, dir: string) => {
    const [a, b] = [norm(p), norm(dir)]
    return a === b || a.startsWith(`${b}/`)
  }

  const select = (step: StepItem | null) => {
    setTabs((t) => ({ ...t, [tabKey]: step?.label ?? '' }))
    setBrowse(null)
    if (step) actions.rememberStep(addr, step.label)
  }

  const folderTop = active?.type === 'folder' ? stepPath(item.path, active.path) : item.path
  const top = browse?.tab === tabId ? browse.top : folderTop

  // Inside the project (or the step's own folder) the browser moves within the tab;
  // anywhere else opens a plain folder page.
  const navigate = (p: string) => {
    if (within(p, item.path) || within(p, folderTop)) setBrowse({ tab: tabId, top: p })
    else openFolder(p)
  }

  const addStep = () => actions.openDialog({ mode: 'step', at: addr, context: `In ${item.label}`, base: item.path })

  const setCard = (field: CardField, value: string | boolean | null, undoLabel?: string) =>
    void actions.run([{ op: 'setCard', at: addr, field, value }], undoLabel)

  const openDefault = (path: string) =>
    api.openFile(profileId, path).then(
      () => toast({ message: `Opened ${nameOf(path)}` }),
      (err) => toast({ message: message(err), kind: 'error' }),
    )

  /** A menu under the button that opened it. */
  const menuBelow = (e: React.MouseEvent, entries: (MenuEntry | 'sep')[]) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4, entries })
  }

  const statusMenu = (e: React.MouseEvent) =>
    menuBelow(
      e,
      STATUSES.map((s) => ({
        label: STATUS_LABEL[s],
        icon: <span className={cx('status-dot', s)} />,
        // Active is the default, so it is written by leaving the field out.
        run: () => setCard('status', s === 'active' ? null : s, `${item.label}: ${STATUS_LABEL[s].toLowerCase()}`),
      })),
    )

  const categoryMenu = (e: React.MouseEvent) => {
    const known = categoriesOf(profile)
    menuBelow(e, [
      ...known.map((c) => ({
        label: c,
        icon: <span className="category-dot" style={{ background: categoryColor(profile, c) }} />,
        run: () => setCard('category', c),
      })),
      ...(known.length ? (['sep'] as const) : []),
      { label: 'New category…', icon: <Tag size={14} />, run: () => setEditing('category') },
      ...(item.category ? [{ label: 'No category', icon: <X size={14} />, run: () => setCard('category', null) }] : []),
    ])
  }

  const workflowEntries = (): (MenuEntry | 'sep')[] => {
    const out: (MenuEntry | 'sep')[] = [{ label: 'Add step…', icon: <Plus size={14} />, run: addStep }]
    if (own) {
      out.push(
        {
          label: 'Use these steps for every project',
          icon: <Share2 size={14} />,
          run: () => void actions.run([{ op: 'setWorkflow', at: addr }], 'These steps are now the profile workflow'),
        },
        { label: 'Reset to profile steps', icon: <RotateCcw size={14} />, run: () => void actions.run([{ op: 'resetSteps', at: addr }], 'Back to the profile steps') },
      )
    }
    return out
  }

  function stepMenu(e: React.MouseEvent, step: StepItem, index: number) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        {
          label: 'Edit…',
          icon: <Pencil size={14} />,
          run: () => actions.openDialog({ mode: 'step', at: addr, index, item: step, context: `In ${item.label}`, base: item.path }),
        },
        {
          label: 'Remove',
          icon: <Trash2 size={14} />,
          danger: true,
          run: () => void actions.run([{ op: 'deleteStep', at: addr, index }], `Removed step "${step.label}"`),
        },
        'sep',
        ...workflowEntries(),
      ],
    })
  }

  return (
    <div className="page wide project-page">
      <div className="page-kicker card-kicker">
        {kicker}
        <span className="sep">·</span>
        {editing === 'category' ? (
          <InlineField
            initial=""
            label="New category"
            onDone={(v) => {
              setEditing(null)
              if (v) setCard('category', v)
            }}
          />
        ) : (
          <button
            className={cx('category-chip', !item.category && 'empty')}
            style={item.category ? ({ '--category': categoryColor(profile, item.category) } as React.CSSProperties) : undefined}
            onClick={categoryMenu}
            title="Category"
          >
            {item.category ?? 'Category'}
          </button>
        )}
      </div>
      <div className="project-head">
        <h1 className="page-title">
          <EntryIcon type="folder" icon={item.icon} size={22} />
          {item.label}
        </h1>
        <button className={cx('status-pill', status)} onClick={statusMenu} title="Status" aria-label={`Status: ${STATUS_LABEL[status]}`}>
          <span className={cx('status-dot', status)} />
          {STATUS_LABEL[status]}
        </button>
        <button
          className={cx('icon-btn pin-btn', item.pinned && 'on')}
          onClick={() => setCard('pinned', item.pinned ? null : true)}
          aria-pressed={!!item.pinned}
          aria-label="Pinned"
          title={item.pinned ? 'Pinned to the top of its heading; click to unpin' : 'Pin to the top of its heading'}
        >
          <Pin size={14} />
        </button>
        <span className="spacer" />
        <span className="path mono">{item.path}</span>
      </div>
      {editing === 'description' ? (
        <InlineField
          initial={item.description ?? ''}
          label="Description"
          multiline
          onDone={(v) => {
            setEditing(null)
            if (v !== null && v !== (item.description ?? '')) setCard('description', v || null)
          }}
        />
      ) : (
        <p className={cx('card-description', !item.description && 'empty')} onClick={() => setEditing('description')} title="Click to edit">
          {item.description || 'Add a description'}
        </p>
      )}

      <div
        className="step-tabs"
        role="tablist"
        aria-label="Workflow"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entries: workflowEntries() })
        }}
      >
        <button role="tab" aria-selected={!active} className={cx('step-tab', !active && 'active')} onClick={() => select(null)}>
          <FolderOpen size={14} className="icon" />
          All files
        </button>
        {steps.map((step, i) => {
          const outside = opensOutside(step)
          return (
            <button
              key={`${i}:${step.label}`}
              role={outside ? undefined : 'tab'}
              aria-selected={outside ? undefined : active === step}
              className={cx('step-tab', active === step && 'active', outside && 'outside', dropAt === i && 'drop-before')}
              title={step.type === 'launch' ? `Start: ${describe(step)}` : step.type === 'link' ? `Open: ${describe(step)}` : describe(step)}
              draggable
              onDragStart={(e) => {
                dragging.current = i
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', step.label)
              }}
              onDragOver={(e) => {
                if (dragging.current === null || dragging.current === i) return
                e.preventDefault()
                setDropAt(i)
              }}
              onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragging.current
                dragging.current = null
                setDropAt(null)
                if (from !== null && from !== i) void actions.run([{ op: 'moveStep', at: addr, from, to: i }])
              }}
              onDragEnd={() => {
                dragging.current = null
                setDropAt(null)
              }}
              onClick={() => (opensOutside(step) ? actions.launchStep(addr, i, step.label, step.type as 'launch' | 'link') : select(step))}
              onContextMenu={(e) => stepMenu(e, step, i)}
            >
              <EntryIcon type={step.type} icon={step.icon} size={14} />
              {step.label}
              {step.type === 'link' && <ExternalLink size={11} className="outside-mark" />}
            </button>
          )
        })}
        <button className="step-tab add" onClick={addStep} title="Add step" aria-label="Add step">
          <Plus size={14} />
        </button>
        {steps.length === 0 && <span className="step-hint">Add steps like assets, modeling or design</span>}
      </div>

      {active?.type === 'report' ? (
        <ReportTab key={stepPath(item.path, active.path)} path={stepPath(item.path, active.path)} profileId={profileId} onOpenDefault={openDefault} />
      ) : active?.type === 'file' ? (
        <FileTab key={stepPath(item.path, active.path)} path={stepPath(item.path, active.path)} onOpenDefault={openDefault} />
      ) : active?.type === 'note' ? (
        <NoteView
          key={stepPath(item.path, active.path)}
          path={stepPath(item.path, active.path)}
          title={active.label}
          compact
          heading={active.label}
          below={
            <div className="path-row">
              <span className="path mono">{stepPath(item.path, active.path)}</span>
            </div>
          }
        />
      ) : (
        <StepFolder
          key={`${tabId}:${top}`}
          path={top}
          // Only a step's own folder offers to be created; the project folder is the entry's business.
          creatable={!!active && top === folderTop}
          project={item.path}
          profile={profile}
          profileId={profileId}
          home={home}
          onNavigate={navigate}
          toast={toast}
          within={within}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** The browser for a folder, or a button to create a step's folder that does not exist yet. */
function StepFolder({
  path,
  creatable,
  project,
  profile,
  profileId,
  home,
  onNavigate,
  toast,
  within,
}: {
  path: string
  creatable: boolean
  project: string
  profile: Profile
  profileId: string
  home: string
  onNavigate: (p: string) => void
  toast: (t: ToastInput) => void
  within: (p: string, dir: string) => boolean
}) {
  const [exists, setExists] = useState<boolean | null>(creatable ? null : true)

  useEffect(() => {
    if (!creatable) return
    let live = true
    api.stat(path).then(
      (s) => live && setExists(s.exists && s.kind === 'dir'),
      () => live && setExists(true),
    )
    return () => {
      live = false
    }
  }, [path, creatable])

  /** Make the folder and any missing folders above it, starting from the project (or the folder's parent). */
  async function create() {
    const base = within(path, project) ? project : parentOf(path)
    const rest = normalizePath(expandHome(path, home)).slice(normalizePath(expandHome(base, home)).length + 1)
    let dir = base
    try {
      for (const name of rest.split('/').filter(Boolean)) {
        await api.fileOp(profileId, { op: 'mkdir', dir, name }).catch((err) => {
          if (!(err instanceof api.ApiError && err.status === 409)) throw err
        })
        dir = `${dir.replace(/\/+$/, '')}/${name}`
      }
      setExists(true)
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: 'error' })
    }
  }

  if (exists === null) return null
  if (!exists) {
    return (
      <div className="placeholder">
        <h3>This folder does not exist yet</h3>
        <p className="mono">{path}</p>
        <button className="btn primary" style={{ marginTop: 14 }} onClick={() => void create()}>
          <FolderOpen size={14} /> Create folder
        </button>
      </div>
    )
  }
  return <FileBrowser top={path} roots={folderRoots(profile)} home={home} onNavigate={onNavigate} toast={toast} />
}

/** A report: its HTML page in a sandboxed frame, loading the files next to it through a folder ticket. */
function ReportTab({ path, profileId, onOpenDefault }: { path: string; profileId: string; onOpenDefault: (p: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let live = true
    setUrl(null)
    setError(null)
    api.fileTicket(profileId, path, true).then(
      (r) => live && setUrl(r.url),
      (err) => live && setError(message(err)),
    )
    return () => {
      live = false
    }
  }, [profileId, path, reload])

  return (
    <div className="step-pane">
      <div className="path-row">
        <span className="path mono">{path}</span>
        <button className="btn ghost" onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={14} /> Reload
        </button>
        <button className="btn ghost" onClick={() => onOpenDefault(path)}>
          <ExternalLink size={14} /> Open in browser
        </button>
      </div>
      {error ? (
        <div className="placeholder">
          <h3>Cannot show this report</h3>
          <p>{error}</p>
        </div>
      ) : url ? (
        <iframe className="report-frame" src={url} title={nameOf(path)} sandbox="allow-scripts allow-popups allow-forms" />
      ) : (
        <div className="preview-loading" />
      )}
    </div>
  )
}

/** One file, shown large: an image, PDF, video, audio, or text. */
function FileTab({ path, onOpenDefault }: { path: string; onOpenDefault: (p: string) => void }) {
  const name = nameOf(path)
  const kind = previewKind({ name, kind: 'file' })
  return (
    <div className="step-pane file-step">
      <div className="path-row">
        <span className="path mono">{path}</span>
        <button className="btn ghost" onClick={() => onOpenDefault(path)}>
          <ExternalLink size={14} /> Open in default app
        </button>
      </div>
      <div className="file-step-body">
        {kind === 'markdown' || kind === 'text' ? (
          <TextPreview entry={{ path, name }} markdown={kind === 'markdown'} />
        ) : (
          <MediaPreview entry={{ path, name }} kind={kind} />
        )}
      </div>
    </div>
  )
}

/** A small inline editor: Enter (without Shift) or leaving saves, Esc cancels. */
function InlineField({ initial, label, multiline, onDone }: { initial: string; label: string; multiline?: boolean; onDone: (value: string | null) => void }) {
  const done = useRef(false)
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v === null ? null : v.trim())
  }
  const props = {
    autoFocus: true,
    defaultValue: initial,
    'aria-label': label,
    placeholder: label,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => finish(e.currentTarget.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        finish(e.currentTarget.value)
      }
      if (e.key === 'Escape') finish(null)
    },
  }
  return multiline ? <textarea className="card-field description" rows={2} {...props} /> : <input className="card-field" {...props} />
}
