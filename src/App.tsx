import { ExternalLink, FolderOpen, Pencil, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getItem, itemKey, type AppState, type ItemAddr, type ItemInput, type NavItem, type Op } from '../shared/config-schema.ts'
import { ContextMenu } from './components/ContextMenu.tsx'
import { ItemDialog } from './components/ItemDialog.tsx'
import { MainPane } from './components/MainPane.tsx'
import { NavPanel } from './components/NavPanel.tsx'
import { Toasts, useToasts } from './components/Toast.tsx'
import * as api from './lib/api.ts'
import { followState, type Connection } from './lib/events.ts'
import { useLocal } from './lib/local.ts'
import { cx, parseKey, type DialogState, type MenuEntry, type MenuState } from './lib/nav.ts'

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
  const toasts = useToasts()

  useEffect(() => followState(setState, setConnection), [])

  const active = state?.profiles.find((p) => p.id === state.activeProfile) ?? state?.profiles[0]
  // Handlers below read the latest profile through a ref, so a quick second edit uses the new revision.
  const activeRef = useRef(active)
  activeRef.current = active
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
      api.setActive(id).catch(fail)
    },
    [fail],
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
      const a = activeRef.current
      if (!a) return
      if (item.type === 'link' || item.type === 'launch') openExternally(addr, item)
      else if (item.type !== 'group') setSelected((s) => ({ ...s, [a.id]: itemKey(addr) }))
    },
    [openExternally, setSelected],
  )

  const goHome = useCallback(() => {
    const a = activeRef.current
    if (a) setSelected((s) => ({ ...s, [a.id]: undefined }))
  }, [setSelected])

  const itemMenu = useCallback(
    (addr: ItemAddr, item: NavItem): (MenuEntry | 'sep')[] => {
      const section = activeRef.current?.profile?.sections[addr.section]
      const where = addr.group === undefined ? section?.title : `${section?.title} / ${section?.items[addr.group]?.label}`
      const entries: (MenuEntry | 'sep')[] = []
      if (item.type === 'folder') entries.push({ label: 'Open in Files', icon: <FolderOpen size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'note') entries.push({ label: 'Open in default app', icon: <ExternalLink size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'link') entries.push({ label: 'Open link', icon: <ExternalLink size={14} />, run: () => openExternally(addr, item) })
      if (item.type === 'launch') entries.push({ label: 'Start', icon: <Play size={14} />, run: () => openExternally(addr, item) })
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
      return run([{ op: 'updateItem', at: dialog.at, item }])
    },
    [dialog, run],
  )

  // Ctrl+1..9 switches profile; Esc leaves edit mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && state) {
        const p = state.profiles[Number(e.key) - 1]
        if (p) {
          e.preventDefault()
          switchProfile(p.id)
        }
      } else if (e.key === 'Escape' && !dialog && !menu && editing) {
        setEditing(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, dialog, menu, editing, switchProfile])

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

  const selection = useMemo(() => {
    if (!active?.profile) return null
    const addr = parseKey(selected[active.id])
    const item = addr ? getItem(active.profile, addr) : undefined
    if (!addr || !item || item.type === 'group' || item.type === 'link' || item.type === 'launch') return null
    return { addr, item }
  }, [active, selected])

  if (!state || !active) {
    return (
      <div className="empty-state">
        {connection === 'offline' ? 'The Workbench service is not running. Start it with bin/workbench.' : 'Loading…'}
      </div>
    )
  }

  return (
    <div className={cx('app', resizing && 'resizing')} style={{ '--nav-w': `${navWidth}px` } as React.CSSProperties}>
      <NavPanel
        profiles={state.profiles}
        active={active}
        connection={connection}
        editing={editing && !active.error}
        setEditing={setEditing}
        selectedKey={selection ? itemKey(selection.addr) : undefined}
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
        onHome={goHome}
        activate={activate}
        openExternally={openExternally}
        startEditing={() => setEditing(true)}
      />
      {dialog && <ItemDialog dialog={dialog} onClose={() => setDialog(null)} onSubmit={submitDialog} />}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <Toasts list={toasts.list} dismiss={toasts.dismiss} />
    </div>
  )
}
