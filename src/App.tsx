import { Archive, ArchiveRestore, ExternalLink, FilePlus, FolderOpen, Pencil, Pin, Play, Sparkles, SquareTerminal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  chatName,
  entrySlot,
  expandHome,
  getItem,
  itemKey,
  joinNotes,
  noteFileName,
  projectHost,
  type Agent,
  type AppState,
  type Chat,
  type ItemAddr,
  type ItemInput,
  type ListAddr,
  type NavItem,
  type NoteSummary,
  type Op,
} from '../shared/config-schema.ts'
import { ConfirmDialog } from './components/ConfirmDialog.tsx'
import { ContextMenu } from './components/ContextMenu.tsx'
import { ItemDialog } from './components/ItemDialog.tsx'
import { MainPane, type SearchState } from './components/MainPane.tsx'
import { NavPanel } from './components/NavPanel.tsx'
import { NewNoteDialog } from './components/NewNoteDialog.tsx'
import type { ProjectActions } from './components/ProjectView.tsx'
import { Toasts, useToasts } from './components/Toast.tsx'
import * as api from './lib/api.ts'
import { CHAT_TAB, ChatsCtx, showProjectTab, slotStep, type ChatsApi } from './lib/chats.ts'
import { followState, onChatsEvent, type Connection } from './lib/events.ts'
import { nameOf } from './lib/files.ts'
import { readLocal, useLocal, writeLocal } from './lib/local.ts'
import {
  CHAT_KEY,
  cx,
  FILES_KEY,
  findEntry,
  listLength,
  NOTE_KEY,
  parseKey,
  type DialogState,
  type MenuEntry,
  type MenuState,
  type Selection,
} from './lib/nav.ts'
import { NotesCtx, type NotesApi } from './lib/notes-ctx.ts'
import { pushRecent, type Recent } from './lib/recent.ts'
import { normalizePath } from './lib/wikilinks.ts'

const NAV_MIN = 220
const NAV_MAX = 520

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [connection, setConnection] = useState<Connection>('connecting')
  const [editing, setEditing] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [resizing, setResizing] = useState(false)
  const [selected, setSelected] = useLocal<Record<string, string | undefined>>('selected', {})
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

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', profile?.accent ?? '#8a8f98')
    document.title = profile ? `${profile.name} · Workbench` : 'Workbench'
  }, [profile?.accent, profile?.name])

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
    (key: string, label: string, step?: string) => {
      const id = activeRef.current?.id
      if (id) setRecent((all) => ({ ...all, [id]: pushRecent(all[id] ?? [], { key, label, step, at: Date.now() }) }))
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
      setSearch((s) => (s.open ? { ...s, open: false } : s))
      if (!key) return
      if (key.startsWith(NOTE_KEY) || key.startsWith(FILES_KEY)) remember(key, nameOf(key.slice(key.indexOf(':') + 1)))
      else {
        const addr = parseKey(key)
        const item = addr && a.profile ? getItem(a.profile, addr) : undefined
        if (item) remember(key, item.label)
      }
    },
    [setSelected, remember],
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
  }, [search.open, setSelected])

  /** Open a note or folder by path; one that is also a nav entry opens as that entry. */
  const openPath = useCallback(
    (type: 'note' | 'folder', path: string) => {
      const p = activeRef.current?.profile
      if (!p) return
      const want = normalizePath(expandHome(path, homeRef.current))
      const addr = findEntry(p, type, (item) => 'path' in item && !!item.path && normalizePath(expandHome(item.path, homeRef.current)) === want)
      navigate(addr ? itemKey(addr) : (type === 'note' ? NOTE_KEY : FILES_KEY) + path)
    },
    [navigate],
  )
  const openNote = useCallback((path: string) => openPath('note', path), [openPath])
  const openFolder = useCallback((path: string) => openPath('folder', path), [openPath])

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

  /** Quick-create: the file, then its nav entry, then open it in Edit. Resolves to an error message or null. */
  const createNote = useCallback(
    async (list: ListAddr, title: string, path: string): Promise<string | null> => {
      const a = activeRef.current
      if (!a?.profile) return 'The profile is not loaded'
      try {
        await api.writeNote(a.id, path, null, `# ${title}\n\n`)
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
    [run, refreshNotes, navigate],
  )

  /** A [[wiki link]] to a missing note: offer to create it in the notes folder. */
  const missingNote = useCallback(
    (name: string) => {
      const create = async () => {
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
          await api.writeNote(a.id, path, null, `# ${file.replace(/\.md$/, '')}\n\n`)
          setFresh(path)
        } catch (err) {
          // Already there (the list was stale): just open it.
          if (!(err instanceof api.ApiError && err.status === 409)) return fail(err)
        }
        refreshNotes()
        openNote(path)
      }
      toasts.push({ message: `No note named "${name}" yet`, action: { label: 'Create', run: () => void create() } })
    },
    [toasts.push, fail, refreshNotes, openNote],
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
      if (item.type === 'link' || item.type === 'launch') openExternally(addr, item)
      else if (item.type !== 'group') navigate(itemKey(addr))
    },
    [openExternally, navigate],
  )

  const goHome = useCallback(() => navigate(undefined), [navigate])

  /** Open something from recent work, on the step it was on. */
  const openRecent = useCallback(
    (r: Recent) => {
      const a = activeRef.current
      const addr = parseKey(r.key)
      const item = addr && a?.profile ? getItem(a.profile, addr) : undefined
      if (a && r.step && item?.type === 'folder') {
        writeLocal('projectTab', { ...readLocal<Record<string, string>>('projectTab', {}), [`${a.id}|${item.path}`]: r.step })
      }
      navigate(r.key)
    },
    [navigate],
  )

  // Chats of the active profile. The service keeps the programs; this is the
  // list, fetched again on each `chats` event.
  const [chatList, setChatList] = useState<{ profile: string; list: Chat[] } | null>(null)
  const [closing, setClosing] = useState<Chat | null>(null)

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
      const project = findEntry(p, 'folder', (item) => item.type === 'folder' && projectHost(item.path) === chat.host)
      const item = project && getItem(p, project)
      if (project && item?.type === 'folder') {
        showProjectTab(a.id, item.path, chat.slot ? slotStep(chat.slot) : CHAT_TAB + chat.id)
        return navigate(itemKey(project))
      }
      const entry = findEntry(p, 'chat', (it) => it.type === 'chat' && entrySlot(it) === chat.host)
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
    }
  }, [active, chatList, fail, upsertChat, openChat, closeChat])
  const chatsRef = useRef(chatsApi)
  chatsRef.current = chatsApi

  const newChatIn = useCallback(
    async (addr: ItemAddr, agent: Agent) => {
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
        if (item) remember(itemKey(addr), item.label, label)
      },
    }),
    [run, fail, toasts.push, remember],
  )

  const itemMenu = useCallback(
    (addr: ItemAddr, item: NavItem): (MenuEntry | 'sep')[] => {
      const section = activeRef.current?.profile?.sections[addr.section]
      const where = addr.group === undefined ? section?.title : `${section?.title} / ${section?.items[addr.group]?.label}`
      const entries: (MenuEntry | 'sep')[] = []
      if (item.type === 'folder') {
        const card = (field: 'pinned' | 'status', value: string | boolean | null, label?: string) =>
          void run([{ op: 'setCard', at: addr, field, value }], label)
        const status = item.status ?? 'active'
        entries.push(
          { label: 'Open in Files', icon: <FolderOpen size={14} />, run: () => openExternally(addr, item) },
          { label: 'New chat', icon: <Sparkles size={14} />, run: () => void newChatIn(addr, 'claude') },
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
          run: () => setDialog({ mode: 'note', list: { section: addr.section, group: addr.index }, context: `Under ${section?.title} / ${item.label}` }),
        })
      }
      if (entries.length) entries.push('sep')
      entries.push(
        { label: 'Edit…', icon: <Pencil size={14} />, run: () => setDialog({ mode: 'edit', at: addr, item, context: `Under ${where}` }) },
        { label: 'Delete', icon: <Trash2 size={14} />, danger: true, run: () => void run([{ op: 'deleteItem', at: addr }], `Deleted "${item.label}"`) },
      )
      return entries
    },
    [openExternally, run, newChatIn],
  )

  const submitDialog = useCallback(
    async (item: ItemInput) => {
      if (!dialog) return false
      if (dialog.mode === 'add') return run([{ op: 'addItem', to: dialog.list, index: dialog.index, item }])
      if (dialog.mode === 'edit') return run([{ op: 'updateItem', at: dialog.at, item }])
      if (dialog.mode === 'step') {
        if (dialog.index === undefined) return run([{ op: 'addStep', at: dialog.at, step: item }])
        return run([{ op: 'updateStep', at: dialog.at, index: dialog.index, step: item }])
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
      const move = (ev: PointerEvent) => setNavWidth(Math.max(NAV_MIN, Math.min(NAV_MAX, ev.clientX)))
      const up = () => {
        setResizing(false)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [setNavWidth],
  )

  const selection = useMemo<Selection | null>(() => {
    if (!active?.profile) return null
    const key = selected[active.id]
    if (key?.startsWith(NOTE_KEY)) return { kind: 'note', path: key.slice(NOTE_KEY.length) }
    if (key?.startsWith(FILES_KEY)) return { kind: 'files', path: key.slice(FILES_KEY.length) }
    if (key?.startsWith(CHAT_KEY)) return { kind: 'chat', id: key.slice(CHAT_KEY.length) }
    const addr = parseKey(key)
    const item = addr ? getItem(active.profile, addr) : undefined
    if (!addr || !item || item.type === 'group' || item.type === 'link' || item.type === 'launch') return null
    return { kind: 'entry', addr, item }
  }, [active, selected])

  const notesApi = useMemo<NotesApi | null>(() => {
    if (!active) return null
    const home = active.profile?.home
    return {
      profile: active.id,
      root: active.profile?.notes,
      suggestedRoot: `${home && home !== '~' ? home.replace(/\/+$/, '') : '~'}/notes`,
      setRoot,
      list: notesList,
      open: openNote,
      missing: missingNote,
      changed: notesChanged,
      notify: (message, kind) => toasts.push({ message, kind }),
      fresh,
      clearFresh: () => setFresh(null),
    }
  }, [active, setRoot, notesList, openNote, missingNote, notesChanged, toasts.push, fresh])

  if (!state || !active || !notesApi || !chatsApi) {
    return (
      <div className="empty-state">
        {connection === 'offline' ? 'The Workbench service is not running. Start it with bin/workbench.' : 'Loading…'}
      </div>
    )
  }

  return (
    <NotesCtx.Provider value={notesApi}>
      <ChatsCtx.Provider value={chatsApi}>
      <div className={cx('app', resizing && 'resizing')} style={{ '--nav-w': `${navWidth}px` } as React.CSSProperties}>
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
          openMenu={setMenu}
          itemMenu={itemMenu}
          chatMarks={chatMarks}
          notify={(message, kind) => toasts.push({ message, kind })}
          onSwitch={switchProfile}
          onResizeStart={onResizeStart}
          onHome={goHome}
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
          openRecent={openRecent}
          onHome={goHome}
          activate={activate}
          openExternally={openExternally}
          startEditing={() => setEditing(true)}
        />
        {dialog?.mode === 'note' ? (
          <NewNoteDialog context={dialog.context} onClose={() => setDialog(null)} onCreate={(title, path) => createNote(dialog.list, title, path)} />
        ) : (
          dialog && <ItemDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} />
        )}
        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
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
      </ChatsCtx.Provider>
    </NotesCtx.Provider>
  )
}
