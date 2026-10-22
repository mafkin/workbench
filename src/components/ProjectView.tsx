// A project: a folder entry with its card (category, status, pin, description)
// and its workflow steps as tabs. "All files" is the project folder; a folder
// step shows its folder in the browser, a note step its note in place, a report
// its HTML page, a file step one file large, and launcher and link steps open
// outside. Steps are the project's own `steps:` or, until it has any, the
// profile's `workflow:`. A chat step is claude (or the shell) in its tab, and
// chats started with New chat are tabs after the steps. "Git", after All files
// in a project that is in a repository, is its changes, branches and history;
// "Claude setup" is what claude loads in the project folder.
import {
  Blocks,
  ChevronDown,
  ExternalLink,
  FastForward,
  FolderOpen,
  GitBranch,
  History,
  MessageSquarePlus,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Share2,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  CATEGORY_PALETTE,
  categoriesOf,
  categoryColor,
  CHAT_COLORS,
  chatName,
  chatProgram,
  expandHome,
  folderRoots,
  normalizePath,
  projectHost,
  STATUSES,
  stepPath,
  stepSlot,
  stepsOf,
  type CARD_FIELDS,
  type Chat,
  type ItemAddr,
  type NavItem,
  type Op,
  type Profile,
  type Status,
  type StepItem,
} from '../../shared/config-schema.ts'
import type { GitMark } from '../../shared/git.ts'
import * as api from '../lib/api.ts'
import { byPin, carriesPaths, CHAT_TAB, droppedPaths, onProjectTab, pasteInto, PATHS_TYPE, quotePaths, useChats } from '../lib/chats.ts'
import { nameOf, parentOf, previewKind } from '../lib/files.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type DialogState, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { ago } from '../lib/recent.ts'
import { agentEntries } from './AgentMenu.tsx'
import { ChatPane } from './ChatPane.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { agentIcon, EntryIcon } from './EntryIcon.tsx'
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
  /** Servers running (or declared and down) in a project folder, from the last check. */
  servers: (path: string) => { up: number; down: number } | undefined
  openServers: () => void
  /** The project's repository: branch and counts from the last check; undefined when it isn't in one. */
  git: (path: string) => GitMark | undefined
  /** Check the repositories again (after a change in the Git tab). */
  gitChanged: () => void
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

const describe = (s: StepItem) =>
  s.type === 'launch' ? [s.command, ...s.args].join(' ') : s.type === 'link' ? s.url : s.type === 'chat' ? `${s.agent === 'shell' ? 'Shell' : 'Claude'} in ${s.path ?? 'the project folder'}` : s.path

const ClaudeSetupView = lazy(() => import('./ClaudeSetupView.tsx'))
const GitView = lazy(() => import('./GitView.tsx'))
/** The saved tab of a project showing its Claude setup. */
const SETUP_TAB = 'setup:'
/** The saved tab of a project showing its Git tab. */
export const GIT_TAB = 'git:'

/** Names for the chat colours, in the order of CHAT_COLORS. */
const COLOR_NAMES = ['Slate', 'Sage', 'Sand', 'Heather', 'Teal', 'Clay', 'Grey']
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ProjectView({ addr, item, kicker, profile, profileId, home, actions, openFolder, toast, onTab }: Props) {
  const steps = stepsOf(profile, item)
  const own = item.steps !== undefined
  const [tabs, setTabs] = useLocal<Record<string, string>>('projectTab', {})
  const tabKey = `${profileId}|${item.path}`
  const chats = useChats()
  const host = projectHost(item.path)
  const adhoc = chats.list.filter((c) => c.host === host && !c.slot).sort(byPin)
  const slotChat = (s: StepItem) => chats.list.find((c) => c.slot === stepSlot(item.path, s.label)) ?? null
  const saved = tabs[tabKey] ?? ''
  const activeChat = saved.startsWith(CHAT_TAB) ? (adhoc.find((c) => CHAT_TAB + c.id === saved) ?? null) : null
  // Until the list arrives, a chat tab cannot be told from a closed one.
  const waitingForChats = saved.startsWith(CHAT_TAB) && !chats.loaded
  const setupOn = saved === SETUP_TAB
  const gitMark = actions.git(item.path)
  const gitOn = saved === GIT_TAB
  const active = activeChat || setupOn || gitOn ? null : (steps.find((s) => s.label === saved && !opensOutside(s)) ?? null)
  const tabId = activeChat ? saved : (active?.label ?? '')
  const [browse, setBrowse] = useState<{ tab: string; top: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<'description' | 'category' | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropChat, setDropChat] = useState<string | null>(null)
  const dragging = useRef<number | null>(null)
  // The browser's colour picker, for "Other colour…" on a category.
  const colourInput = useRef<HTMLInputElement>(null)
  // Where the last right-click on this page was, for follow-up menus (Chat here as…).
  const lastPoint = useRef({ x: 0, y: 0 })
  const hasAgents = Object.keys(profile.agents ?? {}).length > 0
  const status = item.status ?? 'active'
  const crumb = activeChat ? chatName(activeChat) : setupOn ? 'Claude setup' : gitOn ? 'Git' : (active?.label ?? null)

  useEffect(() => onTab(crumb), [crumb])
  // A chat opened from elsewhere (the nav menu, a notification) picks its tab here.
  useEffect(() => onProjectTab((key, tab) => key === tabKey && setTabs((t) => ({ ...t, [key]: tab }))), [tabKey])

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

  const selectSetup = () => {
    setTabs((t) => ({ ...t, [tabKey]: SETUP_TAB }))
    setBrowse(null)
  }

  const selectGit = () => {
    setTabs((t) => ({ ...t, [tabKey]: GIT_TAB }))
    setBrowse(null)
  }

  const selectChat = (chat: Chat) => {
    setTabs((t) => ({ ...t, [tabKey]: CHAT_TAB + chat.id }))
    setBrowse(null)
  }

  /**
   * New chat in the project, or with `path` in a folder inside it (Chat here).
   * `agent` comes from a menu; without one the project's default starts.
   */
  const newChat = async (agent?: string, path?: string) => {
    const chat = await chats.start({ at: addr, agent, path })
    if (chat) selectChat(chat)
  }

  /** The agent menu for New chat ▾: Claude, the agent profiles (the default marked), Shell. */
  const startMenu = (e: React.MouseEvent) =>
    menuBelow(e, agentEntries(profile.agents, { current: item.agent, shell: true, run: (a) => void newChat(a), edit: () => chats.editAgents(item.path) }))

  /** The agent New chat starts in this project; Claude is the default and written by leaving the field out. */
  const defaultAgentMenu = (e: React.MouseEvent) =>
    menuBelow(
      e,
      agentEntries(profile.agents, {
        current: item.agent,
        mark: 'this project',
        run: (a) => setCard('agent', a === 'claude' ? null : a, `New chat in ${item.label} starts ${a === 'claude' ? 'Claude' : a}`),
        edit: () => chats.editAgents(item.path),
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

  const handoff = async (chat: Chat) => {
    const next = await chats.handoff(chat)
    if (next) selectChat(next)
  }

  // Earlier Claude sessions in the project folder and below; one already open is shown, not started twice.
  const historyMenu = async (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const sessions = await chats.history(item.path)
    const open = new Map(chats.list.filter((c) => c.session).map((c) => [c.session, c]))
    const entries: MenuEntry[] = sessions.slice(0, 15).map((s) => ({
      label: s.title,
      detail: `${normalizePath(s.cwd) === normalizePath(item.path) ? '' : `${s.cwd} · `}${open.has(s.id) ? 'open' : ago(s.mtime)}`,
      icon: <Sparkles size={14} />,
      run: () => {
        const chat = open.get(s.id)
        if (chat) return chats.open(chat)
        void chats.start({ at: addr, resume: s.id, path: s.cwd }).then((c) => c && selectChat(c))
      },
    }))
    setMenu({ x: r.left, y: r.bottom + 4, entries: entries.length ? entries : [{ label: 'No Claude sessions in this folder yet', disabled: true, run() {} }] })
  }

  function chatMenu(e: React.MouseEvent, chat: Chat) {
    e.preventDefault()
    e.stopPropagation()
    const at = { x: e.clientX, y: e.clientY }
    const colours: (MenuEntry | 'sep')[] = [
      ...CHAT_COLORS.map((c, i) => ({
        label: COLOR_NAMES[i] ?? c,
        icon: <span className="category-dot" style={{ background: c }} />,
        run: () => void chats.update(chat, { color: c }),
      })),
      ...(chat.color ? (['sep', { label: 'No colour', icon: <X size={14} />, run: () => void chats.update(chat, { color: null }) }] as const) : []),
    ]
    setMenu({
      ...at,
      entries: [
        { label: 'Rename…', icon: <Pencil size={14} />, run: () => setRenaming(chat.id) },
        { label: 'Colour…', icon: <Palette size={14} />, run: () => setMenu({ ...at, entries: colours }) },
        chat.pinned
          ? { label: 'Unpin', icon: <PinOff size={14} />, run: () => void chats.update(chat, { pinned: false }) }
          : { label: 'Pin', icon: <Pin size={14} />, run: () => void chats.update(chat, { pinned: true }) },
        ...(chat.agent === 'claude' && chat.session ? [{ label: 'Summarize and continue', icon: <FastForward size={14} />, run: () => void handoff(chat) }] : []),
        'sep',
        { label: 'Close', icon: <X size={14} />, danger: true, run: () => chats.close(chat) },
      ],
    })
  }

  /** Paths dropped on a chat's tab are typed into its prompt. */
  const chatDrop = (chat: Chat) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!carriesPaths(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropChat(chat.id)
    },
    onDragLeave: () => setDropChat((d) => (d === chat.id ? null : d)),
    onDrop: (e: React.DragEvent) => {
      setDropChat(null)
      if (!carriesPaths(e)) return
      e.preventDefault()
      pasteInto(chat.id, quotePaths(droppedPaths(e)))
      selectChat(chat)
    },
  })

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
    const at = e.currentTarget.getBoundingClientRect()
    menuBelow(e, [
      ...known.map((c) => ({
        label: c,
        icon: <span className="category-dot" style={{ background: categoryColor(profile, c) }} />,
        run: () => setCard('category', c),
      })),
      ...(known.length ? (['sep'] as const) : []),
      { label: 'New category…', icon: <Tag size={14} />, run: () => setEditing('category') },
      ...(item.category
        ? [
            { label: `Colour of ${item.category}…`, icon: <Palette size={14} />, run: () => colourMenu(at, item.category!) },
            { label: 'No category', icon: <X size={14} />, run: () => setCard('category', null) },
          ]
        : []),
    ])
  }

  /** A category's colour, for every project in it: the palette, any colour, or back to the palette's pick. */
  const colourMenu = (at: DOMRect, name: string) => {
    const set = (color: string | null) => void actions.run([{ op: 'setCategory', name, color }], color ? `${name} is now ${color}` : `${name} has the palette's colour again`)
    setMenu({ x: at.left, y: at.bottom + 4, entries: [
      ...CATEGORY_PALETTE.map((c, i) => ({ label: COLOR_NAMES[i] ?? c, icon: <span className="category-dot" style={{ background: c }} />, run: () => set(c) })),
      'sep',
      {
        label: 'Other colour…',
        icon: <Palette size={14} />,
        run: () => {
          const input = colourInput.current
          if (!input) return
          input.value = categoryColor(profile, name)
          input.onchange = () => set(input.value)
          input.click()
        },
      },
      ...(profile.categories?.[name] ? [{ label: "Palette's pick", icon: <X size={14} />, run: () => set(null) }] : []),
    ] })
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
    <div className="page wide project-page" onContextMenuCapture={(e) => (lastPoint.current = { x: e.clientX, y: e.clientY })}>
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
        <input ref={colourInput} type="color" className="visually-hidden" tabIndex={-1} aria-hidden />
        {(hasAgents || item.agent) && (
          <button
            className={cx('agent-chip', !item.agent && 'empty')}
            onClick={defaultAgentMenu}
            title="The agent New chat starts in this project"
            aria-label={`Agent for New chat: ${item.agent ?? 'Claude'}`}
          >
            <Sparkles size={11} />
            {item.agent ?? 'Claude'}
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
      <CardDates profileId={profileId} path={item.path} servers={actions.servers(item.path)} onServers={actions.openServers} git={gitMark} onGit={selectGit} />

      <div
        className="step-tabs"
        role="tablist"
        aria-label="Workflow"
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entries: workflowEntries() })
        }}
      >
        <button role="tab" aria-selected={!active && !activeChat && !setupOn && !gitOn} className={cx('step-tab', !active && !activeChat && !setupOn && !gitOn && 'active')} onClick={() => select(null)}>
          <FolderOpen size={14} className="icon" />
          All files
        </button>
        {(gitMark || gitOn) && (
          <button role="tab" aria-selected={gitOn} className={cx('step-tab', gitOn && 'active')} onClick={selectGit} title="Changes, commits, branches and history of this project's repository">
            <GitBranch size={14} className="icon" />
            Git
            {gitMark && gitMark.changed + gitMark.conflicts > 0 && <span className={cx('tab-count', gitMark.conflicts > 0 && 'danger')}>{gitMark.changed + gitMark.conflicts}</span>}
          </button>
        )}
        <button
          role="tab"
          aria-selected={setupOn}
          className={cx('step-tab', setupOn && 'active')}
          onClick={selectSetup}
          title="What claude loads in this folder: skills, MCP servers, agents, commands, hooks and plugins"
        >
          <Blocks size={14} className="icon" />
          Claude setup
        </button>
        {steps.map((step, i) => {
          const outside = opensOutside(step)
          const stepChat = step.type === 'chat' ? slotChat(step) : null
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
                e.dataTransfer.effectAllowed = 'copyMove'
                e.dataTransfer.setData('text/plain', step.label)
                // A path step can also be dropped on a chat, which types its path.
                if ('path' in step && step.path && step.type !== 'chat') {
                  e.dataTransfer.setData(PATHS_TYPE, JSON.stringify([expandHome(stepPath(item.path, step.path), home)]))
                }
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
        {steps.length === 0 && adhoc.length === 0 && <span className="step-hint">Add steps like assets, modeling or design</span>}
        {adhoc.map((chat) => {
          const on = activeChat?.id === chat.id
          const Icon = agentIcon(chat.agent)
          return (
            <div
              key={chat.id}
              role="tab"
              tabIndex={0}
              aria-selected={on}
              className={cx('step-tab chat-tab', on && 'active', chat.color && 'colored', dropChat === chat.id && 'dropping', chat.state !== 'running' && 'idle')}
              style={chat.color ? ({ '--chat': chat.color } as React.CSSProperties) : undefined}
              title={[chatName(chat), chat.agentProfile, chat.cwd].filter(Boolean).join(' · ')}
              onClick={() => selectChat(chat)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && selectChat(chat)}
              onContextMenu={(e) => chatMenu(e, chat)}
              {...chatDrop(chat)}
            >
              <Icon size={14} className="icon" />
              {renaming === chat.id ? (
                <InlineField
                  initial={chat.label ?? chatName(chat)}
                  label="Chat name"
                  onDone={(v) => {
                    setRenaming(null)
                    if (v !== null) void chats.update(chat, { label: v || null })
                  }}
                />
              ) : (
                <span className="chat-name">{chatName(chat)}</span>
              )}
              {chat.bypass && <ShieldAlert size={12} className="bypass-mark" aria-label="Permissions bypassed" />}
              {chat.attention && !on && <span className="attention" aria-label="Needs you" />}
              {chat.pinned ? (
                <Pin size={11} className="pin-mark" aria-label="Pinned" />
              ) : (
                <button
                  className="tab-close"
                  aria-label={`Close ${chatName(chat)}`}
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation()
                    chats.close(chat)
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
        <span className="tab-spacer" />
        <button className="tab-action" onClick={() => void newChat()} title={`Start ${item.agent ?? 'Claude'} in the project folder`}>
          <MessageSquarePlus size={14} />
          New chat
        </button>
        <button
          className="tab-action more"
          aria-label="More kinds of chat"
          onClick={startMenu}
        >
          <ChevronDown size={13} />
        </button>
        <button className="tab-action" onClick={(e) => void historyMenu(e)} title="Earlier Claude sessions in this folder">
          <History size={14} />
          History
        </button>
      </div>

      {setupOn ? (
        <Suspense fallback={null}>
          <ClaudeSetupView profileId={profileId} profile={profile} folder={item.path} />
        </Suspense>
      ) : gitOn ? (
        <Suspense fallback={null}>
          <GitView key={`${profileId}|${item.path}`} profileId={profileId} path={item.path} toast={toast} onChanged={actions.gitChanged} />
        </Suspense>
      ) : waitingForChats ? null : activeChat ? (
        <ChatPane key={activeChat.id} chat={activeChat} />
      ) : active?.type === 'chat' ? (
        <ChatPane
          key={stepSlot(item.path, active.label)}
          chat={slotChat(active)}
          start={(resume) => chats.start({ at: addr, step: steps.indexOf(active), resume })}
          historyPath={stepPath(item.path, active.path ?? '.')}
        />
      ) : active?.type === 'report' ? (
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
          chatMenu={folderChatMenu}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** "Created 3 Mar 2026 · Updated 2 h ago": the folder's birth, and its last commit or newest file. */
function CardDates({
  profileId,
  path,
  servers,
  onServers,
  git,
  onGit,
}: {
  profileId: string
  path: string
  servers?: { up: number; down: number }
  onServers: () => void
  git?: GitMark
  onGit: () => void
}) {
  const [dates, setDates] = useState<{ created: number | null; updated: number | null; source: 'git' | 'files' } | null>(null)
  useEffect(() => {
    let live = true
    api.projectDates(profileId, path).then(
      (d) => live && setDates(d),
      () => live && setDates(null),
    )
    return () => {
      live = false
    }
  }, [profileId, path])
  const running = servers && (servers.up || servers.down)
  if (!running && !git && (!dates || (!dates.created && !dates.updated))) return null
  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return (
    <p className="card-dates">
      {git && (
        <>
          <button className={cx('link-btn card-git', git.conflicts > 0 && 'danger')} onClick={onGit} title="Open the Git tab">
            <GitBranch size={12} /> {git.branch ?? 'detached'}
            {git.conflicts > 0 ? ` · ${git.conflicts} in conflict` : git.changed ? ` · ${git.changed} changed` : ''}
            {git.ahead || git.behind ? ` · ↑${git.ahead} ↓${git.behind}` : ''}
          </button>
          {(running || (dates && (dates.created || dates.updated))) && ' · '}
        </>
      )}
      {servers && running ? (
        <>
          <button className={cx('link-btn card-servers', servers.down > 0 && 'down')} onClick={onServers}>
            {servers.up ? `${servers.up} ${servers.up === 1 ? 'server' : 'servers'} running` : ''}
            {servers.up && servers.down ? ', ' : ''}
            {servers.down ? `${servers.down} down` : ''}
          </button>
          {dates && (dates.created || dates.updated) && ' · '}
        </>
      ) : null}
      {dates?.created && <span title={new Date(dates.created).toLocaleString()}>Created {day(dates.created)}</span>}
      {dates?.created && dates.updated && ' · '}
      {dates?.updated && (
        <span title={`${dates.source === 'git' ? 'Last commit' : 'Newest file'}: ${new Date(dates.updated).toLocaleString()}`}>
          Updated {ago(dates.updated)}
          {dates.source === 'git' ? ' (last commit)' : ''}
        </span>
      )}
    </p>
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
