// A project: a folder entry with its workflow steps as tabs. "All files" is the
// project folder; a folder step shows its folder in the browser, a note step
// its note in place, and a launcher step starts its program. Steps are the
// project's own `steps:` or, until it has any, the profile's `workflow:`.
import { FolderOpen, Pencil, Plus, RotateCcw, Share2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { expandHome, folderRoots, normalizePath, stepPath, stepsOf, type ItemAddr, type NavItem, type Op, type Profile, type StepItem } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { parentOf } from '../lib/files.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type DialogState, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { ContextMenu } from './ContextMenu.tsx'
import { EntryIcon } from './EntryIcon.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { NoteView } from './NoteView.tsx'
import type { ToastInput } from './Toast.tsx'

/** What a project page needs from the app. */
export interface ProjectActions {
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  openDialog: (d: DialogState) => void
  launchStep: (addr: ItemAddr, index: number, label: string) => void
  rememberStep: (addr: ItemAddr, label: string) => void
}

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

const describe = (s: StepItem) => (s.type === 'launch' ? [s.command, ...s.args].join(' ') : s.path)

export function ProjectView({ addr, item, kicker, profile, profileId, home, actions, openFolder, toast, onTab }: Props) {
  const steps = stepsOf(profile, item)
  const own = item.steps !== undefined
  const [tabs, setTabs] = useLocal<Record<string, string>>('projectTab', {})
  const tabKey = `${profileId}|${item.path}`
  const active = steps.find((s) => s.label === tabs[tabKey] && s.type !== 'launch') ?? null
  const tabId = active?.label ?? ''
  const [browse, setBrowse] = useState<{ tab: string; top: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const dragging = useRef<number | null>(null)

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
      <div className="page-kicker">{kicker}</div>
      <div className="project-head">
        <h1 className="page-title">
          <EntryIcon type="folder" icon={item.icon} size={22} />
          {item.label}
        </h1>
        <span className="path mono">{item.path}</span>
      </div>

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
          const launch = step.type === 'launch'
          return (
            <button
              key={`${i}:${step.label}`}
              role={launch ? undefined : 'tab'}
              aria-selected={launch ? undefined : active === step}
              className={cx('step-tab', active === step && 'active', launch && 'launch', dropAt === i && 'drop-before')}
              title={launch ? `Start: ${describe(step)}` : describe(step)}
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
              onClick={() => (launch ? actions.launchStep(addr, i, step.label) : select(step))}
              onContextMenu={(e) => stepMenu(e, step, i)}
            >
              <EntryIcon type={step.type} icon={step.icon} size={14} />
              {step.label}
            </button>
          )
        })}
        <button className="step-tab add" onClick={addStep} title="Add step" aria-label="Add step">
          <Plus size={14} />
        </button>
        {steps.length === 0 && <span className="step-hint">Add steps like assets, modeling or design</span>}
      </div>

      {active?.type === 'note' ? (
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
