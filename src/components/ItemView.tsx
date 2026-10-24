// An item: its card (pin, description, the agent and skills for its chats) and
// its steps as tabs. A new item is blank; you add what it needs. A files step is
// the item's folder in the browser; a folder step shows another folder, a note
// step its note in place, a report its HTML page, a file step one file large,
// and launcher and link steps open outside. A chat step is claude (or the shell)
// in its tab; chats started with New chat live in the dock. Git and Claude setup
// are the drawer's tools on the rail (part 12): `git:` and `setup:` lines in a
// page get no tab. An older project without `steps:` shows All files and the
// profile's workflow; its first change writes them as its own. With a single
// tab there is no tab row: the step fills the page.
import { ExternalLink, FileText, FolderOpen, Pencil, Pin, Plus, RefreshCw, RotateCcw, Share2, ShieldAlert, Sparkles, SquareTerminal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  chatProgram,
  expandHome,
  FOLDER_STEPS,
  folderRoots,
  itemBase,
  joinNotes,
  normalizePath,
  projectRef,
  STEP_LABEL,
  stepPath,
  stepSlot,
  stepsOf,
  tabSteps,
  type CARD_FIELDS,
  type ItemAddr,
  type NavItem,
  type Op,
  type Profile,
  type StepItem,
} from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { onProjectTab, PATHS_TYPE, useChats } from '../lib/chats.ts'
import { nameOf, parentOf, previewKind } from '../lib/files.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type DialogState, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { agentEntries } from './AgentMenu.tsx'
import { ChatPane } from './ChatPane.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { EntryIcon } from './EntryIcon.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { MediaPreview, TextPreview } from './FilePreview.tsx'
import { NoteView } from './NoteView.tsx'
import type { ToastInput } from './Toast.tsx'

/** What a project page needs from the app. */
export interface ItemActions {
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  openDialog: (d: DialogState) => void
  /** Start a launcher step, or open a link step in the browser. */
  launchStep: (addr: ItemAddr, index: number, label: string, kind: 'launch' | 'link') => void
  rememberStep: (addr: ItemAddr, label: string) => void
  /** Check the repositories again (after a change in the rail's Git view). */
  gitChanged: () => void
}

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
  actions: ItemActions
  openFolder: (path: string) => void
  toast: (t: ToastInput) => void
}

const describe = (s: StepItem) =>
  s.type === 'launch'
    ? [s.command, ...s.args].join(' ')
    : s.type === 'link'
      ? s.url
      : s.type === 'chat'
        ? `${s.agent === 'shell' ? 'Shell' : 'Claude'} in ${s.path ?? 'the item’s folder'}`
        : s.type === 'files'
          ? 'The item’s folder'
          : s.type === 'git'
            ? "Changes, commits, branches and history of this item's repository"
            : s.type === 'setup'
              ? 'What claude loads in this folder: skills, MCP servers, agents, commands, hooks and plugins'
              : s.path

/** The item's own page, as a tab beside its steps. */
const PAGE_TAB = 'page:'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ItemView({ addr, item, kicker, profile, profileId, home, actions, openFolder, toast }: Props) {
  const notes = useNotes()
  // Every step by its index in the page (ops address them so); the tabs leave out Git and Claude setup.
  const steps = stepsOf(profile, item)
  const shown = tabSteps(steps)
  const own = item.steps !== undefined
  // Relative step paths, launchers and chats start in the item's folder, else in home.
  const base = itemBase(profile, item)
  const ref = projectRef(item)
  const [tabs, setTabs] = useLocal<Record<string, string>>('projectTab', {})
  const tabKey = `${profileId}|${ref}`
  const chats = useChats()
  const slotChat = (s: StepItem) => chats.list.find((c) => c.slot === stepSlot(ref, s.label)) ?? null
  const saved = tabs[tabKey] ?? ''
  const inTab = shown.filter((s) => !opensOutside(s))
  // One tab fills the page: the tab row shows from two on (or for a lone launcher or link, which needs its button).
  // Chats started with New chat live in the dock (part 12), not in this row.
  const showRow = shown.length >= 2 || shown.some(opensOutside)
  const blank = shown.length === 0
  // With a row of tabs, the item's own page is one of them.
  const pageTab = !!item.page && !!profile.notes && showRow
  const onPage = pageTab && saved === PAGE_TAB
  // The saved step by its label, else the first.
  const active = onPage ? null : (inTab.find((s) => s.label === saved) ?? inTab[0] ?? null)
  const tabId = onPage ? PAGE_TAB : (active?.label ?? '')
  /** An older project's first step change writes the tabs it showed as its own. */
  const seeded = <T extends Op>(op: T): T => (own ? op : { ...op, seed: steps })
  const quickAddButtons = () => (
    <>
      <button className="btn" onClick={() => void quickAdd('files')}>
        <FolderOpen size={14} /> File browser
      </button>
      <button className="btn" onClick={() => void quickAdd('note')}>
        <FileText size={14} /> Note
      </button>
      <button className="btn ghost" onClick={addStep}>
        <Plus size={14} /> More…
      </button>
    </>
  )
  const [browse, setBrowse] = useState<{ tab: string; top: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<'description' | null>(null)
  const dragging = useRef<number | null>(null)
  // Where the last right-click on this page was, for follow-up menus (Chat here as…).
  const lastPoint = useRef({ x: 0, y: 0 })
  const hasAgents = Object.keys(profile.agents ?? {}).length > 0

  // A chat opened from elsewhere (the nav menu, a notification) picks its tab here.
  useEffect(() => onProjectTab((key, tab) => key === tabKey && setTabs((t) => ({ ...t, [key]: tab }))), [tabKey])

  const norm = (p: string) => normalizePath(expandHome(p, home))
  const within = (p: string, dir: string) => {
    const [a, b] = [norm(p), norm(dir)]
    return a === b || a.startsWith(`${b}/`)
  }

  const select = (step: StepItem) => {
    setTabs((t) => ({ ...t, [tabKey]: step.label }))
    setBrowse(null)
    actions.rememberStep(addr, step.label)
  }

  /**
   * New chat in the project, or with `path` in a folder inside it (Chat here).
   * `agent` comes from a menu; without one the project's default starts. The
   * chat shows in the dock (part 12).
   */
  const newChat = async (agent?: string, path?: string) => {
    const chat = await chats.start({ at: addr, agent, path })
    if (chat) chats.open(chat)
  }

  /** The agent New chat starts in this project; Claude is the default and written by leaving the field out. */
  const defaultAgentMenu = (e: React.MouseEvent) =>
    menuBelow(
      e,
      agentEntries(profile.agents, {
        current: item.agent,
        mark: 'this item',
        run: (a) => setCard('agent', a === 'claude' ? null : a, `New chat in ${item.label} starts ${a === 'claude' ? 'Claude' : a}`),
        edit: () => chats.editAgents(base),
      }),
    )

  /** Chat here, Chat here as… and Shell here, for the file browser's menus. */
  const folderChatMenu = (dir: string): MenuEntry[] => [
    { label: 'Chat here', icon: <Sparkles size={14} />, run: () => void newChat(undefined, dir) },
    ...(hasAgents
      ? [
          {
            label: 'Chat here as…',
            icon: <Sparkles size={14} />,
            run: () => setMenu({ ...lastPoint.current, entries: agentEntries(profile.agents, { current: item.agent, run: (a) => void newChat(a, dir) }) }),
          },
        ]
      : []),
    { label: 'Shell here', icon: <SquareTerminal size={14} />, run: () => void newChat('shell', dir) },
  ]

  const folderTop = active?.type === 'folder' ? stepPath(base, active.path) : base
  const top = browse?.tab === tabId ? browse.top : folderTop

  // Inside the item's folder (or the step's own folder) the browser moves within the tab;
  // anywhere else opens a plain folder page.
  const navigate = (p: string) => {
    if ((item.path && within(p, item.path)) || within(p, folderTop)) setBrowse({ tab: tabId, top: p })
    else openFolder(p)
  }

  const stepDialog = (presetType?: StepItem['type']) =>
    actions.openDialog({ mode: 'step', at: addr, context: `In ${item.label}`, base, needsFolder: !item.path, ...(own ? {} : { seed: steps }), ...(presetType ? { presetType } : {}) })
  const addStep = () => stepDialog()

  /** The empty item's buttons: a built-in step goes straight in (once the item has a folder); the others ask. */
  const quickAdd = async (type: StepItem['type']) => {
    const label = STEP_LABEL[type]
    if (!label || !item.path || !(FOLDER_STEPS as readonly string[]).includes(type)) return stepDialog(type)
    if (await actions.run([seeded({ op: 'addStep', at: addr, step: { label, type } } as Op)], `Added ${label}`)) setTabs((t) => ({ ...t, [tabKey]: label }))
  }

  /** Only the tab goes: its folder or file stays on disk. */
  const removeStep = (step: StepItem, index: number) =>
    void actions.run([seeded({ op: 'deleteStep', at: addr, index } as Op)], `Removed the ${step.label} tab; its files stay`)

  const setCard = (field: CardField, value: string | boolean | null, undoLabel?: string) =>
    void actions.run([{ op: 'setCard', at: addr, field, value }], undoLabel)
  const setSkills = (names: string[]) => void actions.run([{ op: 'setSkills', at: addr, names }], `Skills pinned on ${item.label} changed`)

  /** The card's skills chip: every skill claude loads here and the wiki's, ticked when pinned on this page. */
  async function skillsMenu(e: React.MouseEvent) {
    const pinned = item.skills ?? []
    const r = e.currentTarget.getBoundingClientRect()
    const at = { x: r.left, y: r.bottom + 4 }
    try {
      const setup = await api.claudeSetup(profileId, item.path ?? null, addr.drawer)
      const has = (n: string) => pinned.some((p) => p.toLowerCase() === n.toLowerCase())
      const toggle = (n: string) => setSkills(has(n) ? pinned.filter((p) => p.toLowerCase() !== n.toLowerCase()) : [...pinned, n])
      const docs = setup.skills.filter((s) => !s.overriddenBy)
      const entries: (MenuEntry | 'sep')[] = docs.map((s) => ({ label: `/${s.name}`, detail: s.scope === 'wiki' ? 'wiki' : s.plugin ?? s.scope, kind: 'checkbox', checked: has(s.name), run: () => toggle(s.name) }))
      const unknown = pinned.filter((p) => !docs.some((s) => s.name.toLowerCase() === p.toLowerCase()))
      for (const n of unknown) entries.push({ label: `/${n}`, detail: 'not found', kind: 'checkbox', checked: true, run: () => toggle(n) })
      if (!entries.length) entries.push({ label: 'No skills to pin: add one in ~/.claude/skills or <wiki>/skills', disabled: true, run: () => {} })
      setMenu({ ...at, entries })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: 'error' })
    }
  }

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

  // The profile's workflow is a template: add its steps here, or make this item's steps the template.
  const workflowEntries = (): (MenuEntry | 'sep')[] => {
    const out: (MenuEntry | 'sep')[] = [{ label: 'Add step…', icon: <Plus size={14} />, run: addStep }]
    if (profile.workflow.length) {
      out.push({ label: 'Add profile steps', icon: <RotateCcw size={14} />, run: () => void actions.run([seeded({ op: 'addWorkflow', at: addr } as Op)], 'Added the profile steps') })
      // The template is a page: edit it like any other.
      if (profile.notes) out.push({ label: 'Open Workflow.md', icon: <FileText size={14} />, run: () => notes.open(joinNotes(profile.notes!, 'Workflow.md')) })
    }
    if (steps.length) {
      out.push({
        label: 'Save as profile steps',
        icon: <Share2 size={14} />,
        run: () => void actions.run([seeded({ op: 'setWorkflow', at: addr } as Op)], 'These steps are now the profile steps'),
      })
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
          run: () => actions.openDialog({ mode: 'step', at: addr, index, item: step, context: `In ${item.label}`, base, ...(own ? {} : { seed: steps }) }),
        },
        {
          label: 'Remove tab',
          detail: 'Files stay',
          icon: <Trash2 size={14} />,
          danger: true,
          run: () => removeStep(step, index),
        },
        'sep',
        ...workflowEntries(),
      ],
    })
  }

  /** Add step by the title when there is no tab row. */
  const chatActions = (inHead: boolean) =>
    inHead && !blank ? (
      <button className="tab-action" onClick={addStep} title="Add step" aria-label="Add step">
        <Plus size={14} />
      </button>
    ) : null

  return (
    <div className="page wide item-view" onContextMenuCapture={(e) => (lastPoint.current = { x: e.clientX, y: e.clientY })}>
      <div className="page-kicker card-kicker">
        {kicker}
        {(hasAgents || item.agent) && (
          <button
            className={cx('agent-chip', !item.agent && 'empty')}
            onClick={defaultAgentMenu}
            title="The agent New chat starts from this item"
            aria-label={`Agent for New chat: ${item.agent ?? 'Claude'}`}
          >
            <Sparkles size={11} />
            {item.agent ?? 'Claude'}
          </button>
        )}
        {item.page && (
          <button className={cx('agent-chip skills-chip', !item.skills?.length && 'empty')} onClick={(e) => void skillsMenu(e)} title="Skills pinned on this page: chats started here are told to use them" aria-label={`Skills for chats here: ${item.skills?.length ? item.skills.join(', ') : 'none'}`}>
            <Pin size={11} />
            {item.skills?.length ? item.skills.join(', ') : 'Skills'}
          </button>
        )}
      </div>
      <div className="item-head">
        <h1 className="page-title">
          <EntryIcon type="folder" icon={item.icon} size={22} />
          {item.label}
        </h1>
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
        {!showRow && chatActions(true)}
        {item.path && <span className="path mono">{item.path}</span>}
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

      {showRow && <div
        className="step-tabs"
        role="tablist"
        aria-label="Workflow"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entries: workflowEntries() })
        }}
      >
        {pageTab && (
          <button role="tab" aria-selected={onPage} className={cx('step-tab', onPage && 'active')} title={item.page} onClick={() => setTabs((t) => ({ ...t, [tabKey]: PAGE_TAB }))}>
            <FileText size={14} />
            Page
          </button>
        )}
        {shown.map((step) => {
          const i = steps.indexOf(step)
          const outside = opensOutside(step)
          const stepChat = step.type === 'chat' ? slotChat(step) : null
          return (
            <button
              key={`${i}:${step.label}`}
              role={outside ? undefined : 'tab'}
              aria-selected={outside ? undefined : active === step}
              className={cx('step-tab', active === step && 'active', outside && 'outside', dropAt === i && 'drop-before')}
              onKeyDown={(e) => e.key === 'Delete' && removeStep(step, i)}
              title={step.type === 'launch' ? `Start: ${describe(step)}` : step.type === 'link' ? `Open: ${describe(step)}` : describe(step)}
              draggable
              onDragStart={(e) => {
                dragging.current = i
                e.dataTransfer.effectAllowed = 'copyMove'
                e.dataTransfer.setData('text/plain', step.label)
                // A path step can also be dropped on a chat, which types its path.
                const stepFolder = step.type === 'files' ? item.path : 'path' in step && step.type !== 'chat' ? step.path && stepPath(base, step.path) : undefined
                if (stepFolder) e.dataTransfer.setData(PATHS_TYPE, JSON.stringify([expandHome(stepFolder, home)]))
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
                if (from !== null && from !== i) void actions.run([seeded({ op: 'moveStep', at: addr, from, to: i } as Op)])
              }}
              onDragEnd={() => {
                dragging.current = null
                setDropAt(null)
              }}
              onClick={() => (opensOutside(step) ? actions.launchStep(addr, i, step.label, step.type as 'launch' | 'link') : select(step))}
              onContextMenu={(e) => stepMenu(e, step, i)}
            >
              <EntryIcon type={step.type} icon={step.icon} agent={step.type === 'chat' ? chatProgram(step.agent) : undefined} size={14} />
              {step.label}
              {stepChat?.bypass && <ShieldAlert size={12} className="bypass-mark" aria-label="Permissions bypassed" />}
              {step.type === 'link' && <ExternalLink size={11} className="outside-mark" />}
              {stepChat?.attention && active !== step && <span className="attention" aria-label="Needs you" />}
            </button>
          )
        })}
        <button className="step-tab add" onClick={addStep} title="Add step" aria-label="Add step">
          <Plus size={14} />
        </button>
      </div>}

      {!showRow && !blank && <div className="step-gap" />}
      {onPage ? (
        <NoteView key={item.page} path={joinNotes(profile.notes!, item.page!)} title={item.label} compact heading="Page" />
      ) : !active ? (
        blank ? (
          item.page && profile.notes ? (
            // A page without a Workflow: the page itself, with the ways to give it tabs beneath.
            <div className="item-page" onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, entries: workflowEntries() }))}>
              <NoteView key={item.page} path={joinNotes(profile.notes, item.page)} title={item.label} compact heading="Page" />
              <div className="item-empty-actions">
                <span className="hint">Add a tab:</span>
                {quickAddButtons()}
              </div>
            </div>
          ) : (
            <div className="item-empty" onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, entries: workflowEntries() }))}>
              <p>This item is empty. Add what it needs:</p>
              <div className="item-empty-actions">{quickAddButtons()}</div>
            </div>
          )
        ) : null
      ) : active.type === 'files' && !item.path ? (
        <p className="item-empty">
          {active.label} shows this item’s folder, and it has none. Give it one in Edit… (right-click it in the nav).
        </p>
      ) : active.type === 'chat' ? (
        <ChatPane
          key={stepSlot(ref, active.label)}
          chat={slotChat(active)}
          start={(resume) => chats.start({ at: addr, step: steps.indexOf(active), resume })}
          historyPath={stepPath(base, active.path ?? '.')}
        />
      ) : active.type === 'report' ? (
        <ReportTab key={stepPath(base, active.path)} path={stepPath(base, active.path)} profileId={profileId} onOpenDefault={openDefault} />
      ) : active.type === 'file' ? (
        <FileTab key={stepPath(base, active.path)} path={stepPath(base, active.path)} onOpenDefault={openDefault} />
      ) : active.type === 'note' ? (
        <NoteView
          key={stepPath(base, active.path)}
          path={stepPath(base, active.path)}
          title={active.label}
          compact
          heading={active.label}
          below={
            <div className="path-row">
              <span className="path mono">{stepPath(base, active.path)}</span>
            </div>
          }
        />
      ) : (
        <StepFolder
          key={`${tabId}:${top}`}
          path={top}
          // Only a folder step's own folder offers to be created; the item's folder is the entry's business.
          creatable={active.type === 'folder' && top === folderTop}
          project={item.path ?? base}
          profile={profile}
          profileId={profileId}
          home={home}
          onNavigate={navigate}
          toast={toast}
          within={within}
          chatMenu={folderChatMenu}
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
  chatMenu,
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
  chatMenu: (dir: string) => MenuEntry[]
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
  return <FileBrowser top={path} roots={folderRoots(profile)} home={home} onNavigate={onNavigate} toast={toast} chatMenu={chatMenu} />
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
export function InlineField({ initial, label, multiline, onDone }: { initial: string; label: string; multiline?: boolean; onDone: (value: string | null) => void }) {
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
