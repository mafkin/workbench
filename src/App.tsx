import { Archive, ArchiveRestore, ArrowLeftRight, ExternalLink, FilePlus, FolderOpen, Pencil, Pin, Play, Sparkles, SquareTerminal, Trash2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatName,
  CONTEXT_FOLDERS,
  CONTEXT_LABEL,
  drawerIndex,
  drawersOf,
  entryAt,
  entrySlot,
  findShared,
  expandHome,
  fillTemplate,
  getItem,
  isoDate,
  itemKey,
  joinNotes,
  noteFileName,
  projectHost,
  projectRef,
  sectionsOf,
  sharedRefs,
  stepsOf,
  themeOf,
  walkItems,
  type AppState,
  type Chat,
  type ContextFolder,
  type ContextStatus,
  type ItemAddr,
  type ItemInput,
  type ListAddr,
  type NavItem,
  type NoteSummary,
  type Op,
  type Profile,
  type ServersScan,
} from '../shared/config-schema.ts'
import { agentEntries } from './components/AgentMenu.tsx'
import { ConfirmDialog } from './components/ConfirmDialog.tsx'
import { ContextMenu } from './components/ContextMenu.tsx'
import { ItemDialog } from './components/ItemDialog.tsx'
import { MainPane, type SearchState } from './components/MainPane.tsx'
import { NavPanel } from './components/NavPanel.tsx'
import { NewNoteDialog } from './components/NewNoteDialog.tsx'
import type { ProjectActions } from './components/ProjectView.tsx'
import type { GitMark } from '../shared/git.ts'
import { Toasts, useToasts } from './components/Toast.tsx'
import * as api from './lib/api.ts'
import { CHAT_TAB, ChatsCtx, showProjectTab, slotStep, type ChatsApi } from './lib/chats.ts'
import { ContextCtx, type ContextApi } from './lib/context.ts'
import type { SwitchItem } from './lib/switcher.ts'
import { followState, onChatsEvent, onContextEvent, type Connection } from './lib/events.ts'
import { nameOf } from './lib/files.ts'
import { readLocal, useLocal } from './lib/local.ts'
import { makeLogo, putLogo } from './lib/logos.ts'
import {
  CHAT_KEY,
  CONTEXT_KEY,
  cx,
  FILES_KEY,
  findEntry,
  listLength,
  NOTE_KEY,
  SERVERS_KEY,
  SETUP_KEY,
  entryId,
  parseKey,
  resolveEntry,
  type DialogState,
  type MenuEntry,
  type MenuState,
  type Selection,
} from './lib/nav.ts'
import { LookCtx, type LookApi } from './lib/look.ts'
import { NotesCtx, type NotesApi } from './lib/notes-ctx.ts'
import { pushRecent, type Recent } from './lib/recent.ts'
import { applyLook, themeById } from './lib/themes.ts'
import { normalizePath } from './lib/wikilinks.ts'

// Dialogs that open on demand load on demand, to keep the main bundle small.
const AgentProfilesDialog = lazy(() => import('./components/AgentProfilesDialog.tsx').then((m) => ({ default: m.AgentProfilesDialog })))
const ProfileDialog = lazy(() => import('./components/ProfileDialog.tsx').then((m) => ({ default: m.ProfileDialog })))
const QuickSwitcher = lazy(() => import('./components/QuickSwitcher.tsx').then((m) => ({ default: m.QuickSwitcher })))
const LookPanel = lazy(() => import('./components/LookPanel.tsx').then((m) => ({ default: m.LookPanel })))
const DrawerDialog = lazy(() => import('./components/DrawerDialog.tsx').then((m) => ({ default: m.DrawerDialog })))

/** The identity of the entry at an address key, if the key is one. */
function idAt(profile: Profile | null | undefined, key: string | undefined): string | undefined {
  const addr = parseKey(key)
  const item = addr && profile ? getItem(profile, addr) : undefined
  return item ? entryId(item) : undefined
}

const NAV_MIN = 220
const NAV_MAX = 520

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [editing, setEditing] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  // Where the last nav menu opened, so a follow-up menu (New chat as…) opens there too.
  const lastMenuAt = useRef({ x: 0, y: 0 })
  const openMenu = useCallback((m: MenuState) => {
    lastMenuAt.current = { x: m.x, y: m.y }
    setMenu(m)
  }, [])
  const [resizing, setResizing] = useState(false)
  const [selected, setSelected] = useLocal<Record<string, string | undefined>>('selected', {})
  // Which entry the selection stands for (entryId), so it follows the entry when it moves.
  const [selectedIds, setSelectedIds] = useLocal<Record<string, string | undefined>>('selectedId', {})
  const [collapsed, setCollapsed] = useLocal<Record<string, boolean>>('collapsed', {})
  const [navWidth, setNavWidth] = useLocal('navWidth', 280)
  const [history, setHistory] = useState<(string | undefined)[]>([])
  const [search, setSearch] = useState<SearchState>({ open: false, query: '' })
  const [notesList, setNotesList] = useState<NoteSummary[]>([])
  const [fresh, setFresh] = useState<string | null>(null)
  const [recent, setRecent] = useLocal<Record<string, Recent[]>>('recent', {})
  const searchRef = useRef<HTMLInputElement>(null)
  const toasts = useToasts()

  useEffect(() => followState(setState, setConnection), [])

  const active = state?.profiles.find((p) => p.id === state.activeProfile) ?? state?.profiles[0]
  // Handlers below read the latest profile through a ref, so a quick second edit uses the new revision.
  const activeRef = useRef(active)
  activeRef.current = active
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const historyRef = useRef(history)
  historyRef.current = history
  const homeRef = useRef(state?.home ?? '')
  homeRef.current = state?.home ?? ''
  const profile = active?.profile ?? null

  // The drawer the nav shows, remembered by name per profile; the first when the name is gone.
  const [drawerPick, setDrawerPick] = useLocal<Record<string, string | undefined>>('drawer', {})
  const drawer = profile && active ? Math.max(0, drawerIndex(profile, drawerPick[active.id] ?? '')) : 0
  const drawerRef = useRef(drawer)
  drawerRef.current = drawer
  const [drawerDialog, setDrawerDialog] = useState<{ index: number | null } | null>(null)
  // Deleting an entry that other drawers show too asks first.
  const [deleting, setDeleting] = useState<{ addr: ItemAddr; item: NavItem; where: string[] } | null>(null)
  const showDrawer = useCallback(
    (index: number) => {
      const a = activeRef.current
      const name = a?.profile ? drawersOf(a.profile)[index]?.name : undefined
      if (a && name) setDrawerPick((s) => ({ ...s, [a.id]: name }))
    },
    [setDrawerPick],
  )

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', profile?.accent ?? '#8a8f98')
    document.title = profile ? `${profile.name} · Workbench` : 'Workbench'
  }, [profile?.accent, profile?.name])

  // The profile's look: its theme's colours, and behind frosted panels the
  // theme's own background or a picture from the backgrounds folder. A picture
  // loads through fetch and a blob URL, because CSS cannot send X-Workbench.
  const theme = themeById(themeOf(profile?.theme))
  const background = profile?.background ?? 'theme'
  const pictureName = background === 'theme' || background === 'none' ? null : background
  const [picture, setPicture] = useState<{ name: string; url: string | null } | null>(null)
  const [lookOpen, setLookOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState<boolean | 'add'>(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  useEffect(() => {
    if (!pictureName) return setPicture(null)
    let live = true
    let url: string | null = null
    api.backgroundImage(pictureName).then(
      (blob) => {
        if (!live) return
        url = URL.createObjectURL(blob)
        setPicture({ name: pictureName, url })
      },
      () => live && setPicture({ name: pictureName, url: null }),
    )
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [pictureName])

  const pictureUrl = picture?.name === pictureName ? picture.url : null
  useEffect(() => applyLook(theme, pictureUrl), [theme, pictureUrl])

  const refresh = useCallback(() => api.getState().then(setState), [])

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof api.ApiError && err.status === 409) {
        void refresh()
        toasts.push({ message: 'The file changed on disk and has been reloaded. Try again.', kind: 'error' })
      } else {
        toasts.push({ message: err instanceof Error ? err.message : String(err), kind: 'error' })
      }
    },
    [refresh, toasts.push],
  )

  const run = useCallback(
    async (ops: Op[], undoLabel?: string) => {
      const a = activeRef.current
      if (!a) return false
      try {
        const { rev } = await api.applyOps(a.id, a.rev, ops)
        await refresh()
        if (undoLabel) {
          toasts.push({
            message: undoLabel,
            action: {
              label: 'Undo',
              run: () =>
                api
                  .undo(a.id, rev)
                  .then(refresh)
                  .catch(fail),
            },
          })
        }
        return true
      } catch (err) {
        fail(err)
        return false
      }
    },
    [refresh, fail, toasts.push],
  )

  const switchProfile = useCallback(
    (id: string) => {
      setState((s) => (s ? { ...s, activeProfile: id } : s))
      setMenu(null)
      setHistory([])
      api.setActive(id).catch(fail)
    },
    [fail],
  )

  /** Add to recent work on Home. */
  const remember = useCallback(
    (key: string, label: string, step?: string, entry?: string) => {
      const id = activeRef.current?.id
      if (id) setRecent((all) => ({ ...all, [id]: pushRecent(all[id] ?? [], { key, label, step, entry, at: Date.now() }) }))
    },
    [setRecent],
  )

  /** Show an entry (by address key), a note (`note:<path>`), a folder (`files:<path>`) or Home (undefined); Back returns. */
  const navigate = useCallback(
    (key: string | undefined) => {
      const a = activeRef.current
      if (!a) return
      const current = selectedRef.current[a.id]
      if (current !== key) setHistory((h) => [...h.slice(-49), current])
      setSelected((s) => ({ ...s, [a.id]: key }))
      setSelectedIds((s) => ({ ...s, [a.id]: idAt(a.profile, key) }))
      setSearch((s) => (s.open ? { ...s, open: false } : s))
      if (!key) return
      if (key.startsWith(NOTE_KEY) || key.startsWith(FILES_KEY)) remember(key, nameOf(key.slice(key.indexOf(':') + 1)))
      else if (key.startsWith(CONTEXT_KEY)) remember(key, CONTEXT_LABEL[key.slice(CONTEXT_KEY.length) as ContextFolder] ?? 'Context')
      else {
        const addr = parseKey(key)
        const item = addr && a.profile ? getItem(a.profile, addr) : undefined
        if (item) remember(key, item.label, undefined, entryId(item))
      }
    },
    [setSelected, setSelectedIds, remember],
  )

  const back = useCallback(() => {
    const a = activeRef.current
    if (!a) return
    if (search.open) {
      setSearch((s) => ({ ...s, open: false }))
      return
    }
    const h = historyRef.current
    if (!h.length) return
    setHistory(h.slice(0, -1))
    setSelected((s) => ({ ...s, [a.id]: h[h.length - 1] }))
    setSelectedIds((s) => ({ ...s, [a.id]: idAt(a.profile, h[h.length - 1]) }))
  }, [search.open, setSelected, setSelectedIds])

  /** Open a note or folder by path; one that is also a nav entry opens as that entry. */
  /** Profiles still in YAML become wikis (the banner's button). */
  const migrate = useCallback(async () => {
    try {
      const { moved } = await api.migrate()
      toasts.push({ message: moved.length ? `Moved ${moved.join(', ')} to pages; the YAML is kept as .bak` : 'Nothing to move' })
      await refresh()
    } catch (err) {
      fail(err)
    }
  }, [refresh, fail, toasts.push])

  const openPath = useCallback(
    (type: 'note' | 'folder', path: string) => {
      const p = activeRef.current?.profile
      if (!p) return
      const want = normalizePath(expandHome(path, homeRef.current))
      const addr = findEntry(p, type, (item) => 'path' in item && !!item.path && normalizePath(expandHome(item.path, homeRef.current)) === want, drawerRef.current)
      navigate(addr ? itemKey(addr) : (type === 'note' ? NOTE_KEY : FILES_KEY) + path)
    },
    [navigate],
  )
  const openNote = useCallback((path: string) => openPath('note', path), [openPath])
  const openFolder = useCallback((path: string) => openPath('folder', path), [openPath])
  /** A context folder: its nav entry when the profile lists one, else its own page. */
  const openContext = useCallback(
    (name: ContextFolder) => {
      const p = activeRef.current?.profile
      const want = p?.notes ? normalizePath(expandHome(`${p.notes}/${name}`, homeRef.current)) : null
      const addr = p && want ? findEntry(p, 'folder', (item) => 'path' in item && !!item.path && normalizePath(expandHome(item.path, homeRef.current)) === want) : null
      navigate(addr ? itemKey(addr) : CONTEXT_KEY + name)
    },
    [navigate],
  )

  const refreshNotes = useCallback(() => {
    const id = activeRef.current?.id
    if (!id) return
    api.listNotes(id).then(
      (list) => activeRef.current?.id === id && setNotesList(list),
      () => activeRef.current?.id === id && setNotesList([]),
    )
  }, [])

  // The list backs wiki links: reload it when the profile or its entries change.
  useEffect(() => setNotesList([]), [active?.id])
  useEffect(() => refreshNotes(), [active?.id, active?.rev, refreshNotes])

  const notesTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const notesChanged = useCallback(() => {
    clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(refreshNotes, 300)
  }, [refreshNotes])

  /** The text of a new page: `templates/page.md` filled in, else a heading. */
  const newPageText = useCallback(async (id: string, title: string) => {
    const { text } = await api.noteTemplate(id, 'page').catch(() => ({ text: null }))
    return text === null ? `# ${title}\n\n` : fillTemplate(text, { date: isoDate(new Date()), title })
  }, [])

  /** The profile's projects (folder entries, in every drawer), for [[Project/path]] links. */
  const projects = useMemo(() => {
    const out: { label: string; path: string }[] = []
    if (active?.profile) for (const { item } of walkItems(active.profile)) if (item.type === 'folder' && item.path) out.push({ label: item.label, path: item.path })
    return out
  }, [active?.profile])

  /** Quick-create: the file, then its nav entry, then open it in Edit. Resolves to an error message or null. */
  const createNote = useCallback(
    async (list: ListAddr, title: string, path: string): Promise<string | null> => {
      const a = activeRef.current
      if (!a?.profile) return 'The profile is not loaded'
      try {
        await api.writeNote(a.id, path, null, await newPageText(a.id, title))
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) return `${path} already exists`
        return err instanceof Error ? err.message : String(err)
      }
      const index = listLength(a.profile, list)
      if (!(await run([{ op: 'addItem', to: list, item: { label: title, type: 'note', path } }]))) {
        return 'The file was created, but its entry could not be added'
      }
      refreshNotes()
      setFresh(path)
      navigate(itemKey({ ...list, index }))
      return null
    },
    [run, refreshNotes, navigate, newPageText],
  )

  /** Create the note a [[wiki link]] names (folders allowed) from the page template, and open it. */
  const createLinkedNote = useCallback(
    async (name: string) => {
      const a = activeRef.current
      const root = a?.profile?.notes
      if (!a || !root) {
        toasts.push({ message: 'Set a notes folder for this profile first', kind: 'error' })
        return
      }
      const parts = name.split('/').map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..')
      const file = noteFileName(parts.pop() ?? '')
      if (!file) return
      const path = joinNotes(root, [...parts, file].join('/'))
      try {
        await api.writeNote(a.id, path, null, await newPageText(a.id, file.replace(/\.md$/, '')))
        setFresh(path)
      } catch (err) {
        // Already there (the list was stale): just open it.
        if (!(err instanceof api.ApiError && err.status === 409)) return fail(err)
      }
      refreshNotes()
      openNote(path)
    },
    [toasts.push, fail, refreshNotes, openNote, newPageText],
  )

  /** A [[wiki link]] to a missing note: offer to create it in the notes folder. */
  const missingNote = useCallback(
    (name: string) => toasts.push({ message: `No note named "${name}" yet`, action: { label: 'Create', run: () => void createLinkedNote(name) } }),
    [toasts.push, createLinkedNote],
  )

  const setRoot = useCallback(
    (value: string) => void run([{ op: 'setProfileField', key: 'notes', value }], `Notes folder set to ${value}`),
    [run],
  )

  const openExternally = useCallback(
    (addr: ItemAddr, item: NavItem) => {
      const a = activeRef.current
      if (!a) return
      api
        .openEntry(a.id, a.rev, addr)
        .then(() => {
          const verb = item.type === 'launch' ? 'Started' : 'Opened'
          toasts.push({ message: `${verb} ${item.label}` })
        })
        .catch(fail)
    },
    [fail, toasts.push],
  )

  const activate = useCallback(
    (addr: ItemAddr, item: NavItem) => {
      // A shared entry does what its original does; the page shows under the shared entry's own address.
      const p = activeRef.current?.profile
      const target = item.type === 'shared' ? (p ? findShared(p, item) : null) : { addr, item }
      if (!target) return
      if (target.item.type === 'link' || target.item.type === 'launch') openExternally(target.addr, target.item)
      else if (target.item.type !== 'group') navigate(itemKey(addr))
    },
    [openExternally, navigate],
  )

  /** Show another drawer; the page stays unless it is an entry of the drawer left. */
  const pickDrawer = useCallback(
    (index: number) => {
      const a = activeRef.current
      if (!a) return
      showDrawer(index)
      const at = parseKey(selectedRef.current[a.id])
      if (at && (at.drawer ?? 0) !== index) navigate(undefined)
    },
    [showDrawer, navigate],
  )

  const goHome = useCallback(() => navigate(undefined), [navigate])

  /** Open something from recent work, on the step it was on. */
  const openRecent = useCallback(
    (r: Recent) => {
      const a = activeRef.current
      const addr = a?.profile && parseKey(r.key) ? resolveEntry(a.profile, r.key, r.entry) : null
      const item = addr && a?.profile ? entryAt(a.profile, addr)?.item : undefined
      if (a && r.step && item?.type === 'folder') {
        // Saved for the project, and heard directly by a project page already showing.
        showProjectTab(a.id, projectRef(item), r.step)
      }
      navigate(addr ? itemKey(addr) : r.key)
    },
    [navigate],
  )

  // Chats of the active profile. The service keeps the programs; this is the
  // list, fetched again on each `chats` event.
  const [chatList, setChatList] = useState<{ profile: string; list: Chat[] } | null>(null)
  const [closing, setClosing] = useState<Chat | null>(null)
  // The agent profile editor, with the folder whose Claude Code agents it suggests.
  const [agentsFor, setAgentsFor] = useState<string | null>(null)

  const refreshChats = useCallback(() => {
    const id = activeRef.current?.id
    if (!id) return
    api.listChats(id).then(
      (list) => activeRef.current?.id === id && setChatList({ profile: id, list }),
      () => {},
    )
  }, [])

  useEffect(() => {
    refreshChats()
    return onChatsEvent((e) => (e === 'reconnected' || e.profile === activeRef.current?.id) && refreshChats())
  }, [active?.id, refreshChats])

  // Servers running in the active profile's projects, for the nav's marks and the
  // project cards: checked every 15 s here, every 3 s while the Servers page is open.
  const [serverScan, setServerScan] = useState<{ profile: string; scan: ServersScan } | null>(null)
  useEffect(() => {
    const id = active?.id
    if (!id) return
    let live = true
    const load = () =>
      api.servers(id).then(
        (scan) => live && setServerScan({ profile: id, scan }),
        () => {},
      )
    void load()
    const timer = setInterval(load, 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active?.id])
  // Each project's repository (branch, changed files, ahead and behind) for the
  // nav, the cards and whether a project has a Git tab: every 15 s, and after a
  // change in a Git tab.
  const [gitScan, setGitScan] = useState<{ profile: string; marks: GitMark[] } | null>(null)
  const gitLoad = useRef<() => void>(() => {})
  useEffect(() => {
    const id = active?.id
    if (!id) return
    let live = true
    const load = () =>
      api.git.marks(id).then(
        (marks) => live && setGitScan({ profile: id, marks }),
        () => {},
      )
    gitLoad.current = () => void load()
    void load()
    const timer = setInterval(load, 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active?.id])
  const gitMarks = useMemo(() => {
    const marks = new Map<string, GitMark>()
    if (gitScan && gitScan.profile === active?.id) for (const m of gitScan.marks) marks.set(m.path, m)
    return marks
  }, [gitScan, active?.id])

  const serverMarks = useMemo(() => {
    const marks = new Map<string, { up: number; down: number }>()
    if (!serverScan || serverScan.profile !== active?.id) return marks
    for (const p of serverScan.scan.projects) {
      const down = p.rows.filter((r) => r.health.state === 'down').length
      const up = p.rows.length - down
      if (up || down) marks.set(p.path, { up, down })
    }
    return marks
  }, [serverScan, active?.id])

  // The active profile's context folders: the nav heading, the context pages, Send to inbox.
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null)
  const refreshContext = useCallback(() => {
    const a = activeRef.current
    if (!a?.profile) return setContextStatus(null)
    const id = a.id
    api.contextStatus(id).then(
      (s) => activeRef.current?.id === id && setContextStatus(s),
      () => activeRef.current?.id === id && setContextStatus(null),
    )
  }, [])
  useEffect(() => {
    setContextStatus(null)
    refreshContext()
    return onContextEvent((e) => (e === 'reconnected' || e.profile === activeRef.current?.id) && refreshContext())
  }, [active?.id, active?.profile?.notes, refreshContext])

  /** Put a chat the service just returned into the list, so its tab shows before the next event. */
  const upsertChat = useCallback((chat: Chat) => {
    setChatList((cur) => (cur?.profile === chat.profile ? { ...cur, list: [...cur.list.filter((c) => c.id !== chat.id), chat] } : cur))
  }, [])

  /** Show a chat: its tab in its project, its chat entry, or a page of its own. */
  const openChat = useCallback(
    (chat: Chat) => {
      const a = activeRef.current
      const p = a?.profile
      if (!a || !p) return
      const project = findEntry(p, 'folder', (item) => item.type === 'folder' && projectHost(projectRef(item)) === chat.host, drawerRef.current)
      const item = project && getItem(p, project)
      if (project && item?.type === 'folder') {
        showProjectTab(a.id, projectRef(item), chat.slot ? slotStep(chat.slot) : CHAT_TAB + chat.id)
        return navigate(itemKey(project))
      }
      const entry = findEntry(p, 'chat', (it) => it.type === 'chat' && entrySlot(it) === chat.host, drawerRef.current)
      navigate(entry ? itemKey(entry) : CHAT_KEY + chat.id)
    },
    [navigate],
  )

  // Desktop notifications for a chat that needs you while the window is not looked at;
  // permission is asked on the first chat started (a click).
  const askedNotify = useRef(false)
  const askNotifications = () => {
    if (askedNotify.current || typeof Notification === 'undefined' || Notification.permission !== 'default') return
    askedNotify.current = true
    void Notification.requestPermission().catch(() => {})
  }
  const attention = useRef(new Map<string, boolean>())
  useEffect(() => {
    if (!chatList) return
    for (const c of chatList.list) {
      const was = attention.current.get(c.id)
      attention.current.set(c.id, c.attention)
      if (!c.attention || was !== false) continue
      if ((document.hasFocus() && !document.hidden) || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue
      const n = new Notification(`${chatName(c)} needs you`, { body: c.cwd, tag: c.id })
      n.onclick = () => {
        window.focus()
        openChat(c)
        n.close()
      }
    }
  }, [chatList, openChat])

  const closeChat = useCallback(
    async (chat: Chat) => {
      try {
        await api.closeChat(chat.id)
      } catch (err) {
        return fail(err)
      }
      setChatList((cur) => (cur ? { ...cur, list: cur.list.filter((c) => c.id !== chat.id) } : cur))
      toasts.push({ message: chat.agent === 'claude' && chat.session ? `Closed ${chatName(chat)}; its session stays in History` : `Closed ${chatName(chat)}` })
    },
    [fail, toasts.push],
  )

  const chatsApi = useMemo<ChatsApi | null>(() => {
    if (!active) return null
    const loaded = chatList?.profile === active.id
    async function attempt<T>(p: Promise<T>): Promise<T | null> {
      try {
        return await p
      } catch (err) {
        fail(err)
        return null
      }
    }
    const keep = (chat: Chat | null) => {
      if (chat) upsertChat(chat)
      return chat
    }
    return {
      profile: active.id,
      list: loaded ? chatList.list : [],
      loaded,
      start: (req) => {
        askNotifications()
        const a = activeRef.current
        if (!a) return Promise.resolve(null)
        return attempt(api.startChat(a.id, a.rev, req)).then(keep)
      },
      restart: (chat, fresh) => attempt(api.restartChat(chat.id, fresh)).then((c) => void keep(c)),
      update: (chat, patch) => attempt(api.updateChat(chat.id, patch)).then((c) => void keep(c)),
      handoff: (chat) => attempt(api.handoffChat(chat.id)).then(keep),
      close: (chat) => (chat.state === 'running' ? setClosing(chat) : void closeChat(chat)),
      history: (path) => api.chatHistory(active.id, path).catch(() => []),
      open: openChat,
      agents: active.profile?.agents ?? {},
      editAgents: (folder) => setAgentsFor(folder ?? active.profile?.home ?? '~'),
    }
  }, [active, chatList, fail, upsertChat, openChat, closeChat])
  const chatsRef = useRef(chatsApi)
  chatsRef.current = chatsApi

  /** A chat in a project: `agent` from a menu, or the project's default. */
  const newChatIn = useCallback(
    async (addr: ItemAddr, agent?: string) => {
      const chat = await chatsRef.current?.start({ at: addr, agent })
      if (chat) openChat(chat)
    },
    [openChat],
  )

  // Running chats (and any that need you) per project or chat entry, for the nav.
  const chatMarks = useMemo(() => {
    const marks = new Map<string, { running: number; attention: boolean }>()
    for (const c of chatsApi?.list ?? []) {
      const m = marks.get(c.host) ?? { running: 0, attention: false }
      if (c.state === 'running') m.running++
      if (c.attention) m.attention = true
      marks.set(c.host, m)
    }
    return marks
  }, [chatsApi?.list])

  const projectActions = useMemo<ProjectActions>(
    () => ({
      run,
      openDialog: setDialog,
      launchStep: (addr, index, label, kind) => {
        const a = activeRef.current
        if (!a) return
        api
          .openEntry(a.id, a.rev, addr, index)
          .then(() => toasts.push({ message: `${kind === 'link' ? 'Opened' : 'Started'} ${label}` }))
          .catch(fail)
      },
      rememberStep: (addr, label) => {
        const item = activeRef.current?.profile ? getItem(activeRef.current.profile, addr) : undefined
        if (item) remember(itemKey(addr), item.label, label, entryId(item))
      },
      servers: (path) => serverMarks.get(path),
      openServers: () => navigate(SERVERS_KEY),
      git: (path) => gitMarks.get(path),
      gitChanged: () => gitLoad.current(),
    }),
    [run, fail, toasts.push, remember, serverMarks, gitMarks, navigate],
  )

  const itemMenu = useCallback(
    (addr: ItemAddr, item: NavItem): (MenuEntry | 'sep')[] => {
      const p = activeRef.current?.profile
      const section = p ? sectionsOf(p, addr.drawer ?? 0)[addr.section] : undefined
      const where = addr.group === undefined ? section?.title : `${section?.title} / ${section?.items[addr.group]?.label}`
      const entries: (MenuEntry | 'sep')[] = []
      if (item.type === 'shared') {
        const found = p ? findShared(p, item) : null
        if (found) {
          entries.push(
            { label: 'Open', icon: <FolderOpen size={14} />, run: () => activate(addr, item) },
            { label: `Go to ${item.drawer}`, icon: <ArrowLeftRight size={14} />, run: () => navigate(itemKey(found.addr)) },
            'sep',
          )
        }
        entries.push({ label: 'Remove from this drawer', icon: <Trash2 size={14} />, danger: true, run: () => void run([{ op: 'deleteItem', at: addr }], `Removed "${item.label}" from this drawer`) })
        return entries
      }
      // Only a page has a card, tabs and chats; a folder link is just the file browser.
      if (item.type === 'folder' && item.page) {
        const card = (field: 'pinned' | 'status', value: string | boolean | null, label?: string) =>
          void run([{ op: 'setCard', at: addr, field, value }], label)
        const status = item.status ?? 'active'
        entries.push(
          { label: 'Open in Files', icon: <FolderOpen size={14} />, run: () => openExternally(addr, item) },
          { label: 'New chat', icon: <Sparkles size={14} />, run: () => void newChatIn(addr) },
          ...(Object.keys(activeRef.current?.profile?.agents ?? {}).length
            ? [
                {
                  label: 'New chat as…',
                  icon: <Sparkles size={14} />,
                  // A second menu where the first one was.
                  run: () =>
                    setMenu({
                      ...lastMenuAt.current,
                      entries: agentEntries(activeRef.current?.profile?.agents, {
                        current: item.agent,
                        run: (agent) => void newChatIn(addr, agent),
                        edit: () => setAgentsFor(item.path ?? null),
                      }),
                    }),
                },
              ]
            : []),
          { label: 'New shell', icon: <SquareTerminal size={14} />, run: () => void newChatIn(addr, 'shell') },
          'sep',
          { label: item.pinned ? 'Unpin' : 'Pin', icon: <Pin size={14} />, run: () => card('pinned', item.pinned ? null : true) },
          ...(['active', 'paused', 'done'] as const)
            .filter((s) => s !== status && !(s === 'active' && status === 'archived'))
            .map((s) => ({
              label: `Mark ${s}`,
              icon: <span className={cx('status-dot', s)} />,
              // Active is the default: the field is left out.
              run: () => card('status', s === 'active' ? null : s, `${item.label}: ${s}`),
            })),
          status === 'archived'
            ? { label: 'Unarchive', icon: <ArchiveRestore size={14} />, run: () => card('status', null, `${item.label}: back from the archive`) }
            : { label: 'Archive', icon: <Archive size={14} />, run: () => card('status', 'archived', `Archived "${item.label}"`) },
        )
      }
      if (item.type === 'note') entries.push({ label: 'Open in default app', icon: <ExternalLink size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'link') entries.push({ label: 'Open link', icon: <ExternalLink size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'launch') entries.push({ label: 'Start', icon: <Play size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'group') {
        entries.push({
          label: 'New note…',
          icon: <FilePlus size={14} />,
          run: () => setDialog({ mode: 'note', list: { drawer: addr.drawer, section: addr.section, group: addr.index }, context: `Under ${section?.title} / ${item.label}` }),
        })
      }
      // Show this entry in the profile's other drawers too.
      const all = p ? drawersOf(p) : []
      if (p && all.length > 1 && item.type === 'folder' && item.page) {
        // A page is in a drawer when that drawer's page links it.
        const pageOf = item.type === 'folder' ? item.page : undefined
        const shownIn = new Set(all.flatMap((d, i) => (pageOf && d.sections.some((s) => s.items.some((x) => x.type === 'folder' && x.page === pageOf)) ? [i] : [])))
        if (entries.length) entries.push('sep')
        all.forEach((d, i) => {
          if (i === (addr.drawer ?? 0)) return
          const on = shownIn.has(i)
          entries.push({
            label: `Show in ${d.name}`,
            kind: 'checkbox',
            checked: on,
            run: () => void run([{ op: 'setShared', at: addr, drawer: i, on: !on }], on ? `"${item.label}" no longer in ${d.name}` : `"${item.label}" also in ${d.name}`),
          })
        })
      }
      if (entries.length) entries.push('sep')
      const remove = () => {
        // What other drawers show of it goes too: ask first.
        const refs = p ? (item.type === 'group' ? item.items.map((_, i) => ({ ...addr, group: addr.index, index: i })) : [addr]).flatMap((a) => sharedRefs(p, a)) : []
        const where = [...new Set(refs.map((r) => all[r.addr.drawer ?? 0]?.name).filter((n): n is string => !!n))]
        if (where.length) setDeleting({ addr, item, where })
        else void run([{ op: 'deleteItem', at: addr }], `Deleted "${item.label}"`)
      }
      entries.push(
        { label: 'Edit…', icon: <Pencil size={14} />, run: () => setDialog({ mode: 'edit', at: addr, item, context: `Under ${where}` }) },
        { label: 'Delete', icon: <Trash2 size={14} />, danger: true, run: remove },
      )
      return entries
    },
    [openExternally, run, newChatIn, activate, navigate],
  )

  const submitDialog = useCallback(
    async (item: ItemInput, extra?: { folder?: string }) => {
      if (!dialog) return false
      if (dialog.mode === 'add') return run([{ op: 'addItem', to: dialog.list, index: dialog.index, item }])
      if (dialog.mode === 'edit') return run([{ op: 'updateItem', at: dialog.at, item }])
      if (dialog.mode === 'step') {
        // An older project's first change writes the tabs it showed (`seed`).
        const seed = dialog.seed ? { seed: dialog.seed } : {}
        if (dialog.index === undefined) return run([{ op: 'addStep', at: dialog.at, step: item, ...(extra?.folder ? { folder: extra.folder } : {}), ...seed }])
        const ok = await run([{ op: 'updateStep', at: dialog.at, index: dialog.index, step: item, ...seed }])
        // A renamed step that was the open tab stays the open tab.
        const a = activeRef.current
        const project = a?.profile ? getItem(a.profile, dialog.at) : undefined
        const old = dialog.item?.label
        if (ok && a && project?.type === 'folder' && old && item.label !== old && readLocal<Record<string, string>>('projectTab', {})[`${a.id}|${projectRef(project)}`] === old) {
          showProjectTab(a.id, projectRef(project), String(item.label))
        }
        return ok
      }
      return false
    },
    [dialog, run],
  )

  // Ctrl+1..9 switches profile; Esc leaves edit mode; Ctrl+Shift+F searches notes; Alt+← goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && state) {
        const p = state.profiles[Number(e.key) - 1]
        if (p) {
          e.preventDefault()
          switchProfile(p.id)
        }
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        // In a terminal, Ctrl+K belongs to the program (it cuts the line in a shell).
        if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
        e.preventDefault()
        setSwitcherOpen((o) => !o)
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (e.altKey && !e.ctrlKey && e.key === 'ArrowLeft') {
        // In text, Alt+← moves the cursor.
        if ((e.target as HTMLElement | null)?.closest?.('input, textarea, .cm-editor')) return
        e.preventDefault()
        back()
      } else if (e.key === 'Escape' && !dialog && !menu && editing) {
        setEditing(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, dialog, menu, editing, switchProfile, back])

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      setResizing(true)
      // Keep the edge under the pointer, also when the frosted layout insets the panels.
      const offset = e.clientX - navWidth
      const move = (ev: PointerEvent) => setNavWidth(Math.max(NAV_MIN, Math.min(NAV_MAX, ev.clientX - offset)))
      const up = () => {
        setResizing(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setNavWidth, navWidth],
  )

  const selection = useMemo<Selection | null>(() => {
    if (!active?.profile) return null
    const key = selected[active.id]
    if (key?.startsWith(NOTE_KEY)) return { kind: 'note', path: key.slice(NOTE_KEY.length) }
    if (key?.startsWith(FILES_KEY)) return { kind: 'files', path: key.slice(FILES_KEY.length) }
    if (key?.startsWith(CHAT_KEY)) return { kind: 'chat', id: key.slice(CHAT_KEY.length) }
    if (key === SETUP_KEY) return { kind: 'setup' }
    if (key === SERVERS_KEY) return { kind: 'servers' }
    if (key?.startsWith(CONTEXT_KEY)) {
      const name = key.slice(CONTEXT_KEY.length) as ContextFolder
      return CONTEXT_FOLDERS.includes(name) ? { kind: 'context', name } : null
    }
    const addr = key ? resolveEntry(active.profile, key, selectedIds[active.id]) : null
    // A shared entry shows its original's page.
    const found = addr ? entryAt(active.profile, addr) : null
    const item = found?.item
    if (!addr || !found || !item || item.type === 'group' || item.type === 'link' || item.type === 'launch') return null
    const own = getItem(active.profile, addr)
    return { kind: 'entry', addr, item, origin: found.addr, shared: own?.type === 'shared' ? own : undefined }
  }, [active, selected, selectedIds])

  // An entry of another drawer (Ctrl+K, Back, Recent work) brings its drawer along.
  useEffect(() => {
    if (selection?.kind === 'entry' && (selection.addr.drawer ?? 0) !== drawer) showDrawer(selection.addr.drawer ?? 0)
  }, [selection, drawer, showDrawer])

  // The selected entry moved or was renamed: keep its new address and identity.
  useEffect(() => {
    if (!active || selection?.kind !== 'entry') return
    const key = itemKey(selection.addr)
    const id = entryId(selection.shared ?? selection.item)
    if (selected[active.id] !== key) setSelected((s) => ({ ...s, [active.id]: key }))
    if (selectedIds[active.id] !== id) setSelectedIds((s) => ({ ...s, [active.id]: id }))
  }, [active, selection, selected, selectedIds, setSelected, setSelectedIds])

  const lookApi = useMemo<LookApi>(
    () => ({
      pictureFrom: (path) => {
        const a = activeRef.current
        if (!a) return
        api
          .addBackground(a.id, path)
          .then(({ name }) => run([{ op: 'setProfileField', key: 'background', value: name }], `Background: ${name}`))
          .catch(fail)
      },
      logoFrom: (path) => {
        const a = activeRef.current
        const d = a?.profile ? drawersOf(a.profile)[drawerRef.current] : undefined
        if (!a || !d) return
        const index = drawerRef.current
        api
          .fileTicket(a.id, path)
          .then(({ url }) => fetch(url))
          .then((res) => res.blob())
          .then(makeLogo)
          .then(putLogo)
          .then((name) => run([{ op: 'setDrawer', drawer: index, field: 'logo', value: name }], `New logo for ${d.name}`))
          .catch(fail)
      },
    }),
    [run, fail],
  )

  const notesApi = useMemo<NotesApi | null>(() => {
    if (!active) return null
    const home = active.profile?.home
    return {
      profile: active.id,
      root: active.profile?.notes,
      suggestedRoot: `${home && home !== '~' ? home.replace(/\/+$/, '') : '~'}/notes`,
      setRoot,
      list: notesList,
      projects,
      open: openNote,
      openFolder,
      missing: missingNote,
      create: createLinkedNote,
      search: (query) => setSearch({ open: true, query }),
      changed: notesChanged,
      notify: (message, kind) => toasts.push({ message, kind }),
      fresh,
      clearFresh: () => setFresh(null),
    }
  }, [active, setRoot, notesList, projects, openNote, openFolder, missingNote, createLinkedNote, notesChanged, toasts.push, fresh])

  const contextApi = useMemo<ContextApi>(
    () => ({
      status: contextStatus,
      setup: async () => {
        const a = activeRef.current
        if (!a?.profile) return
        // Context lives in the notes folder; a profile without one gets the usual one first.
        if (!a.profile.notes && notesApi && !(await run([{ op: 'setProfileField', key: 'notes', value: notesApi.suggestedRoot }], `Notes folder set to ${notesApi.suggestedRoot}`))) return
        try {
          setContextStatus(await api.setupContext(a.id))
          await refresh()
          openContext('context')
        } catch (err) {
          fail(err)
        }
      },
      open: openContext,
      sendToInbox: (path) => {
        const a = activeRef.current
        if (!a) return
        api.sendToInbox(a.id, path).then(
          (r) => toasts.push({ message: `Copied to the inbox as ${nameOf(r.path)}`, action: { label: 'Open inbox', run: () => openContext('inbox') } }),
          fail,
        )
      },
    }),
    [contextStatus, notesApi, run, navigate, fail, toasts.push, refresh, openContext],
  )

  /** Everything Ctrl+K offers, built when it opens. */
  const switchItems = (): SwitchItem[] => {
    const p = active?.profile
    if (!active || !p || !state) return []
    const items: SwitchItem[] = []
    const all = drawersOf(p)
    const where = (addr: ItemAddr) => {
      const section = sectionsOf(p, addr.drawer ?? 0)[addr.section]
      const group = addr.group !== undefined ? section?.items[addr.group] : undefined
      const heading = group ? `${section?.title} / ${group.label}` : (section?.title ?? '')
      // With several drawers, every drawer's entries are offered, named by drawer.
      return all.length > 1 ? `${all[addr.drawer ?? 0]?.name} › ${heading}` : heading
    }
    {
      const add = (addr: ItemAddr, item: NavItem) => {
        if (item.type === 'group' || item.type === 'shared') return
        const key = itemKey(addr)
        const verb = item.type === 'launch' ? 'Start ' : item.type === 'link' ? 'Open ' : ''
        items.push({ id: `entry:${entryId(item)}`, kind: 'entry', label: `${verb}${item.label}`, detail: where(addr), run: () => activate(addr, item) })
        if (item.type !== 'folder') return
        const mark = item.path ? gitMarks.get(item.path) : undefined
        for (const [i, step] of stepsOf(p, item, !!mark).entries()) {
          const outside = step.type === 'launch' || step.type === 'link'
          const detail = outside
            ? step.type === 'launch'
              ? 'Start in the project'
              : 'Open link'
            : step.type === 'git' && mark
              ? [mark.branch ?? 'detached', mark.changed && `${mark.changed} changed`].filter(Boolean).join(' · ')
              : where(addr)
          items.push({
            id: `step:${entryId(item)}|${step.label}`,
            kind: 'step',
            label: `${item.label} › ${step.label}`,
            detail,
            run: () => (outside ? projectActions.launchStep(addr, i, step.label, step.type as 'launch' | 'link') : openRecent({ key, step: step.label, label: item.label, entry: entryId(item), at: 0 })),
          })
        }
        items.push({ id: `action:chat:${entryId(item)}`, kind: 'action', label: `New chat in ${item.label}`, detail: item.path ?? where(addr), run: () => void newChatIn(addr) })
      }
      for (const { addr, item } of walkItems(p)) add(addr, item)
    }
    for (const n of notesList) items.push({ id: `note:${n.path}`, kind: 'note', label: n.name, detail: n.rel ?? n.path, run: () => openNote(n.path) })
    if (contextStatus?.ready) {
      for (const f of contextStatus.folders) items.push({ id: `context:${f.name}`, kind: 'context', label: CONTEXT_LABEL[f.name], detail: f.path, run: () => navigate(CONTEXT_KEY + f.name) })
    }
    for (const c of chatsApi?.list ?? []) items.push({ id: `chat:${c.id}`, kind: 'chat', label: chatName(c), detail: `${c.cwd} · ${c.state}`, run: () => chatsApi?.open(c) })
    items.push(
      { id: 'page:home', kind: 'page', label: 'Home', detail: 'Recent work and today', run: goHome },
      { id: 'page:setup', kind: 'page', label: 'Claude setup', detail: 'Skills, MCP servers, agents, hooks, plugins', run: () => navigate(SETUP_KEY) },
      { id: 'page:servers', kind: 'page', label: 'Servers', detail: 'What runs in your projects', run: () => navigate(SERVERS_KEY) },
    )
    // New note goes under the shown drawer's heading with the notes (the daily entry's), else its last one.
    const here = sectionsOf(p, drawer)
    const inHere = (type: NavItem['type']) => walkItems(p).find((e) => (e.addr.drawer ?? 0) === drawer && e.item.type === type)?.addr
    const daily = inHere('daily') ?? inHere('note')
    const noteSection = daily ? daily.section : here.length - 1
    if (noteSection >= 0) {
      const list = drawer ? { drawer, section: noteSection } : { section: noteSection }
      items.push({ id: 'action:note', kind: 'action', label: 'New note…', detail: `Under ${here[noteSection].title}`, run: () => setDialog({ mode: 'note', list, context: `Under ${here[noteSection].title}` }) })
    }
    all.forEach((d, i) => {
      if (i !== drawer) items.push({ id: `action:drawer:${d.name}`, kind: 'action', label: `Switch to drawer ${d.name}`, detail: `${d.sections.length} headings`, run: () => pickDrawer(i) })
    })
    if (!active.error) {
      items.push(
        { id: 'action:new-drawer', kind: 'action', label: 'New drawer…', detail: p.name, run: () => setDrawerDialog({ index: null }) },
        { id: 'action:drawer-settings', kind: 'action', label: 'Drawer settings…', detail: all[drawer]?.name ?? '', run: () => setDrawerDialog({ index: drawer }) },
      )
    }
    items.push(
      { id: 'action:look', kind: 'action', label: 'Theme and background…', detail: p.name, run: () => setLookOpen(true) },
      { id: 'action:agents', kind: 'action', label: 'Agent profiles…', detail: p.name, run: () => setAgentsFor(p.home ?? '~') },
      { id: 'action:profile', kind: 'action', label: 'Profile settings…', detail: p.name, run: () => setProfileOpen(true) },
      { id: 'action:edit', kind: 'action', label: 'Edit navigation', detail: 'Drag, add, rename, delete', run: () => setEditing(true) },
    )
    for (const [i, q] of state.profiles.entries()) {
      if (q.id !== active.id) items.push({ id: `action:switch:${q.id}`, kind: 'action', label: `Switch to ${q.profile?.name ?? q.id}`, detail: `Ctrl+${i + 1}`, run: () => switchProfile(q.id) })
    }
    return items
  }

  if (!state || !active || !notesApi || !chatsApi) {
    return (
      <div className="empty-state">
        {connection === 'offline' ? 'The Workbench service is not running. Start it with bin/workbench.' : 'Loading…'}
      </div>
    )
  }

  return (
    <NotesCtx.Provider value={notesApi}>
      <ContextCtx.Provider value={contextApi}>
        <ChatsCtx.Provider value={chatsApi}>
          <LookCtx.Provider value={lookApi}>
            <div className={cx('app', resizing && 'resizing', background !== 'none' && 'backdrop')} style={{ '--nav-w': `${navWidth}px` } as React.CSSProperties}>
              <NavPanel
                profiles={state.profiles}
                active={active}
                connection={connection}
                editing={editing && !active.error}
                setEditing={setEditing}
                selectedKey={selection?.kind === 'entry' ? itemKey(selection.addr) : undefined}
                isCollapsed={(key, fallback) => collapsed[key] ?? fallback}
                toggleCollapsed={(key, fallback) => setCollapsed((c) => ({ ...c, [key]: !(c[key] ?? fallback) }))}
                activate={activate}
                run={run}
                openDialog={setDialog}
                openMenu={openMenu}
                itemMenu={itemMenu}
                chatMarks={chatMarks}
                notify={(message, kind) => toasts.push({ message, kind })}
                onSwitch={switchProfile}
                onResizeStart={onResizeStart}
                onHome={goHome}
                onLook={() => setLookOpen(true)}
                onSetup={() => navigate(SETUP_KEY)}
              onServers={() => navigate(SERVERS_KEY)}
              serversActive={selection?.kind === 'servers'}
              serverMarks={serverMarks}
              gitMarks={gitMarks}
              onProfileSettings={() => setProfileOpen(true)}
              onAddProfile={() => setProfileOpen('add')}
                setupActive={selection?.kind === 'setup'}
                contextSelected={selection?.kind === 'context' ? selection.name : null}
                drawer={drawer}
                onDrawer={pickDrawer}
                onNewDrawer={() => setDrawerDialog({ index: null })}
                onMigrate={() => void migrate()}
                onDrawerSettings={() => setDrawerDialog({ index: drawer })}
                filesSelected={selection?.kind === 'files' ? selection.path : null}
                openFiles={(path) => navigate(FILES_KEY + path)}
              />
              <MainPane
                active={active}
                selected={selection}
                search={search}
                setSearch={setSearch}
                searchRef={searchRef}
                canGoBack={search.open || history.length > 0}
                onBack={back}
                openFolder={openFolder}
                toast={toasts.push}
                home={state.home}
                actions={projectActions}
                recent={recent[active.id] ?? []}
                drawer={drawer}
                openRecent={openRecent}
              onServersScan={(scan) => active && setServerScan({ profile: active.id, scan })}
                onHome={goHome}
                activate={activate}
                openExternally={openExternally}
                startEditing={() => setEditing(true)}
              />
              {dialog?.mode === 'note' ? (
                <NewNoteDialog context={dialog.context} onClose={() => setDialog(null)} onCreate={(title, path) => createNote(dialog.list, title, path)} />
              ) : (
                dialog && <ItemDialog dialog={dialog} agents={Object.keys(profile?.agents ?? {})} onClose={() => setDialog(null)} onSubmit={submitDialog} />
              )}
              {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
              <Suspense fallback={null}>
                {lookOpen && profile && (
                  <LookPanel profile={profile} profileId={active.id} run={run} pictureMissing={!!pictureName && picture?.name === pictureName && !picture.url} onClose={() => setLookOpen(false)} />
                )}
                {switcherOpen && <QuickSwitcher items={switchItems()} onClose={() => setSwitcherOpen(false)} />}
                {profileOpen && (
                  <ProfileDialog active={active} profiles={state.profiles} addFirst={profileOpen === 'add'} run={run} onSwitch={switchProfile} onChanged={refresh} onClose={() => setProfileOpen(false)} />
                )}
                {drawerDialog && profile && (
                  <DrawerDialog
                    profile={profile}
                    profileId={active.id}
                    index={drawerDialog.index}
                    run={run}
                    onShow={(name) => {
                      setDrawerPick((s) => ({ ...s, [active.id]: name }))
                    }}
                    onDeleted={() => navigate(undefined)}
                    onClose={() => setDrawerDialog(null)}
                  />
                )}
                {agentsFor !== null && profile && (
                  <AgentProfilesDialog profile={profile} profileId={active.id} folder={agentsFor} run={run} onClose={() => setAgentsFor(null)} />
                )}
              </Suspense>
              {deleting && (
                <ConfirmDialog
                  title={`Delete ${deleting.item.label}?`}
                  action="Delete"
                  onCancel={() => setDeleting(null)}
                  onConfirm={() => {
                    setDeleting(null)
                    void run([{ op: 'deleteItem', at: deleting.addr }], `Deleted "${deleting.item.label}"`)
                  }}
                >
                  It is also shown in {deleting.where.join(' and ')}; it goes from there too. Undo brings it back everywhere.
                </ConfirmDialog>
              )}
              {closing && (
                <ConfirmDialog
                  title={`Close ${chatName(closing)}?`}
                  action="Close"
                  onCancel={() => setClosing(null)}
                  onConfirm={() => {
                    setClosing(null)
                    void closeChat(closing)
                  }}
                >
                  {closing.agent === 'claude'
                    ? 'claude stops. The conversation stays in History, where you can resume it.'
                    : 'The shell, and anything running in it, stops.'}
                </ConfirmDialog>
              )}
              <Toasts list={toasts.list} dismiss={toasts.dismiss} />
            </div>
          </LookCtx.Provider>
        </ChatsCtx.Provider>
      </ContextCtx.Provider>
    </NotesCtx.Provider>
  )
}
