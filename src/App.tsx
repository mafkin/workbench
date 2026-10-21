import { ExternalLink, FilePlus, FolderOpen, Pencil, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  expandHome,
  getItem,
  itemKey,
  joinNotes,
  noteFileName,
  type AppState,
  type ItemAddr,
  type ItemInput,
  type ListAddr,
  type NavItem,
  type NoteSummary,
  type Op,
} from '../shared/config-schema.ts'
import { ContextMenu } from './components/ContextMenu.tsx'
import { ItemDialog } from './components/ItemDialog.tsx'
import { MainPane, type SearchState } from './components/MainPane.tsx'
import { NavPanel } from './components/NavPanel.tsx'
import { NewNoteDialog } from './components/NewNoteDialog.tsx'
import { Toasts, useToasts } from './components/Toast.tsx'
import * as api from './lib/api.ts'
import { followState, type Connection } from './lib/events.ts'
import { useLocal } from './lib/local.ts'
import {
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

  /** Show an entry (by address key), a note (`note:<path>`) or Home (undefined); Back returns. */
  const navigate = useCallback(
    (key: string | undefined) => {
      const a = activeRef.current
      if (!a) return
      const current = selectedRef.current[a.id]
      if (current !== key) setHistory((h) => [...h.slice(-49), current])
      setSelected((s) => ({ ...s, [a.id]: key }))
      setSearch((s) => (s.open ? { ...s, open: false } : s))
    },
    [setSelected],
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
      const addr = findEntry(p, type, (entryPath) => normalizePath(expandHome(entryPath, homeRef.current)) === want)
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

  const itemMenu = useCallback(
    (addr: ItemAddr, item: NavItem): (MenuEntry | 'sep')[] => {
      const section = activeRef.current?.profile?.sections[addr.section]
      const where = addr.group === undefined ? section?.title : `${section?.title} / ${section?.items[addr.group]?.label}`
      const entries: (MenuEntry | 'sep')[] = []
      if (item.type === 'folder') entries.push({ label: 'Open in Files', icon: <FolderOpen size={14} />, run: () => openExternally(addr, item) })
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
    [openExternally, run],
  )

  const submitDialog = useCallback(
    async (item: ItemInput) => {
      if (!dialog) return false
      if (dialog.mode === 'add') return run([{ op: 'addItem', to: dialog.list, index: dialog.index, item }])
      if (dialog.mode === 'edit') return run([{ op: 'updateItem', at: dialog.at, item }])
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

  if (!state || !active || !notesApi) {
    return (
      <div className="empty-state">
        {connection === 'offline' ? 'The Workbench service is not running. Start it with bin/workbench.' : 'Loading…'}
      </div>
    )
  }

  return (
    <NotesCtx.Provider value={notesApi}>
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
        <Toasts list={toasts.list} dismiss={toasts.dismiss} />
      </div>
    </NotesCtx.Provider>
  )
}
