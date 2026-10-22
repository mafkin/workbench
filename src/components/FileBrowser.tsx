// The file browser: one folder at the top of an expandable tree, with a
// preview of the selected file beside it. Folders list lazily and again when
// they change on disk. Operations go through the service, which confines them
// to the profile's folders; deletes go to the Trash.
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FilePlus,
  FileText,
  FolderOpen,
  FolderPlus,
  ImageIcon,
  Inbox,
  ListFilter,
  PencilLine,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { expandHome, type FileEntry, type FileOp, type FileOpResult, type MoveResult } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { PATHS_TYPE } from '../lib/chats.ts'
import { useContextFolders } from '../lib/context.ts'
import { PICTURE_EXT, useLook } from '../lib/look.ts'
import { onFilesEvent } from '../lib/events.ts'
import { formatDate, formatSize, isMarkdown, nameOf, parentOf, segments, uniqueName } from '../lib/files.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { normalizePath } from '../lib/wikilinks.ts'
import { ContextMenu } from './ContextMenu.tsx'
import { FileIcon } from './FileIcon.tsx'
import { FilePreview } from './FilePreview.tsx'
import type { ToastInput } from './Toast.tsx'

type Listing = { status: 'loading' } | { status: 'ok'; entries: FileEntry[] } | { status: 'error'; message: string }

type Row = { kind: 'entry'; entry: FileEntry; depth: number; open: boolean } | { kind: 'note'; depth: number; text: string; error?: boolean }

type SortKey = 'name' | 'size' | 'mtime'

interface Props {
  /** The folder at the top of the tree. */
  top: string
  /** The profile's folders: which path-bar steps can be opened. */
  roots: { label: string; path: string }[]
  home: string
  /** Make another folder the top: the path bar, or opening a subfolder. */
  onNavigate: (path: string) => void
  toast: (t: ToastInput) => void
  /** In a project: menu entries to start a chat in a folder (Chat here, Chat here as…, Shell here). */
  chatMenu?: (dir: string) => MenuEntry[]
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function sorted(entries: FileEntry[], key: SortKey, dir: 1 | -1): FileEntry[] {
  const by = (a: FileEntry, b: FileEntry) =>
    key === 'size' ? a.size - b.size : key === 'mtime' ? a.mtime - b.mtime : collator.compare(a.name, b.name)
  // Folders stay first whichever way the list is sorted.
  return [...entries].sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || dir * by(a, b) || collator.compare(a.name, b.name))
}

/** The toolbar, tree and preview; the page around it supplies the heading. */
export function FileBrowser({ top, roots, home, onNavigate, toast, chatMenu }: Props) {
  const notes = useNotes()
  const look = useLook()
  const context = useContextFolders()
  const inbox = context?.status?.ready ? context.status.folders.find((f) => f.name === 'inbox' && f.exists)?.path : undefined
  const profile = notes.profile
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const listingsRef = useRef(listings)
  listingsRef.current = listings
  const [expandedAll, setExpandedAll] = useLocal<Record<string, string[]>>('filesExpanded', {})
  const [showHidden, setShowHidden] = useLocal('filesHidden', false)
  const [sort, setSort] = useLocal<{ key: SortKey; dir: 1 | -1 }>('filesSort', { key: 'name', dir: 1 })
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const dragging = useRef<string[] | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const norm = useCallback((p: string) => normalizePath(expandHome(p, home)), [home])
  const rootPaths = useMemo(() => roots.map((r) => norm(r.path)), [roots, norm])
  const reachable = (p: string) => {
    const abs = norm(p)
    return rootPaths.some((r) => abs === r || abs.startsWith(r === '/' ? '/' : `${r}/`))
  }

  // Expanded folders are remembered per profile and top folder, in this browser.
  const expandKey = `${profile}|${norm(top)}`
  const expanded = useMemo(() => new Set(expandedAll[expandKey] ?? []), [expandedAll, expandKey])
  const setExpanded = (change: (s: Set<string>) => void) =>
    setExpandedAll((all) => {
      const s = new Set(all[expandKey] ?? [])
      change(s)
      return { ...all, [expandKey]: [...s] }
    })

  const load = useCallback(
    async (dir: string) => {
      setListings((l) => (l[dir]?.status === 'ok' ? l : { ...l, [dir]: { status: 'loading' } }))
      try {
        const { entries } = await api.listFiles(profile, dir)
        setListings((l) => ({ ...l, [dir]: { status: 'ok', entries } }))
        return entries
      } catch (err) {
        setListings((l) => ({ ...l, [dir]: { status: 'error', message: message(err) } }))
        return null
      }
    },
    [profile],
  )

  /** Reload a folder if it is listed, whichever way its path was written. */
  const refresh = useCallback(
    (dir: string) => {
      const want = norm(dir)
      for (const key of Object.keys(listingsRef.current)) if (norm(key) === want) void load(key)
    },
    [norm, load],
  )

  useEffect(() => {
    void load(top)
    for (const dir of expanded) void load(dir)
    // Only on opening; the browser is keyed by its top folder.
  }, [])

  useEffect(
    () =>
      onFilesEvent((e) => {
        if (e === 'reconnected') for (const dir of Object.keys(listingsRef.current)) void load(dir)
        else refresh(e.path)
      }),
    [load, refresh],
  )

  // Ctrl+H shows dotfiles, as in Files.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'h') return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, .cm-editor, .scrim')) return
      e.preventDefault()
      setShowHidden((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowHidden])

  const q = filter.trim().toLowerCase()
  const rows = useMemo(() => {
    const walk = (dir: string, depth: number): Row[] => {
      const l = listings[dir]
      if (!l || l.status === 'loading') return depth ? [{ kind: 'note', depth, text: 'Loading…' }] : []
      if (l.status === 'error') return [{ kind: 'note', depth, text: l.message, error: true }]
      const out: Row[] = []
      for (const entry of sorted(l.entries.filter((e) => showHidden || !e.hidden), sort.key, sort.dir)) {
        const open = entry.kind === 'dir' && expanded.has(entry.path)
        const children = open ? walk(entry.path, depth + 1) : []
        // A folder stays when something inside it matches the filter.
        if (q && !entry.name.toLowerCase().includes(q) && !children.some((r) => r.kind === 'entry')) continue
        out.push({ kind: 'entry', entry, depth, open }, ...children)
      }
      return out
    }
    return walk(top, 0)
  }, [listings, top, expanded, showHidden, sort, q])

  const entryRows = rows.filter((r): r is Extract<Row, { kind: 'entry' }> => r.kind === 'entry')
  const byPath = new Map(entryRows.map((r) => [r.entry.path, r.entry]))
  const chosen = selected.map((p) => byPath.get(p)).filter((e): e is FileEntry => !!e)
  const current = chosen.at(-1) ?? null

  useEffect(() => {
    if (!current) return
    treeRef.current?.querySelector(`[data-path="${CSS.escape(current.path)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current?.path])

  const toggle = (dir: string) => {
    const opening = !expanded.has(dir)
    setExpanded((s) => (opening ? s.add(dir) : s.delete(dir)))
    if (opening && listingsRef.current[dir]?.status !== 'ok') void load(dir)
  }

  const pick = (path: string) => {
    setSelected([path])
    setAnchor(path)
  }

  function onRowClick(e: React.MouseEvent, path: string) {
    if (e.shiftKey && anchor) {
      const paths = entryRows.map((r) => r.entry.path)
      const [a, b] = [paths.indexOf(anchor), paths.indexOf(path)]
      if (a >= 0 && b >= 0) {
        setSelected(paths.slice(Math.min(a, b), Math.max(a, b) + 1))
        return
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]))
      setAnchor(path)
      return
    }
    pick(path)
  }

  async function openDefault(path: string) {
    try {
      await api.openFile(profile, path)
      toast({ message: `Opened ${nameOf(path)}` })
    } catch (err) {
      toast({ message: message(err), kind: 'error' })
    }
  }

  /** A folder becomes the top; Markdown opens as a note; anything else in its default app. */
  function openEntry(e: FileEntry) {
    if (e.kind === 'dir') onNavigate(e.path)
    else if (isMarkdown(e.name)) notes.open(e.path)
    else void openDefault(e.path)
  }

  async function run<T extends FileOpResult>(op: FileOp): Promise<T | null> {
    try {
      return await api.fileOp<T>(profile, op)
    } catch (err) {
      toast({ message: message(err), kind: 'error' })
      return null
    }
  }

  async function rename(path: string, raw: string | null) {
    setRenaming(null)
    treeRef.current?.focus()
    const old = nameOf(path)
    const name = raw?.trim()
    if (!name || name === old) return
    const res = await run<{ path: string }>({ op: 'rename', path, name })
    if (!res) return
    refresh(parentOf(path))
    pick(res.path)
    toast({
      message: `Renamed to ${nameOf(res.path)}`,
      action: {
        label: 'Undo',
        run: async () => {
          if (await run({ op: 'rename', path: res.path, name: old })) refresh(parentOf(path))
        },
      },
    })
  }

  /** The folder new items go into: the selected folder, the selected file's folder, or the top. */
  const targetDir = (where?: FileEntry) => {
    const e = where ?? (chosen.length === 1 ? chosen[0] : null)
    if (!e) return top
    return e.kind === 'dir' ? e.path : parentOf(e.path)
  }

  /** A new folder or empty file with a free name, then straight into renaming it. */
  async function create(op: 'mkdir' | 'touch', where?: FileEntry) {
    const dir = targetDir(where)
    const key = Object.keys(listingsRef.current).find((k) => norm(k) === norm(dir)) ?? dir
    const entries = (await load(key)) ?? []
    const taken = new Set(entries.map((e) => e.name))
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = uniqueName(op === 'mkdir' ? 'New folder' : 'New file', taken)
      try {
        const res = await api.fileOp<{ path: string }>(profile, { op, dir, name })
        if (norm(dir) !== norm(top)) setExpanded((s) => s.add(key))
        await load(key)
        pick(res.path)
        setRenaming(res.path)
        return
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 409) taken.add(name)
        else return toast({ message: message(err), kind: 'error' })
      }
    }
  }

  async function trash(paths: string[]) {
    if (!paths.length) return
    const res = await run<{ trashed: string[] }>({ op: 'trash', paths })
    if (!res) return
    for (const p of paths) refresh(parentOf(p))
    setSelected([])
    const what = paths.length === 1 ? nameOf(paths[0]) : `${paths.length} items`
    toast({ message: `Moved ${what} to Trash. Restore it from Trash in Files.` })
  }

  async function move(paths: string[], to: string) {
    const res = await run<MoveResult>({ op: 'move', paths, to })
    if (!res) return
    for (const p of paths) refresh(parentOf(p))
    refresh(to)
    if (res.moved.length) {
      const what = res.moved.length === 1 ? nameOf(res.moved[0].from) : `${res.moved.length} items`
      toast({ message: `Moved ${what} to ${nameOf(to)}`, action: { label: 'Undo', run: () => void undoMove(res.moved) } })
    }
    if (res.skipped.length) {
      toast({ message: res.skipped.map((s) => `${nameOf(s.path)}: ${s.reason}`).join('; '), kind: 'error' })
    }
  }

  async function undoMove(moved: MoveResult['moved']) {
    const back = new Map<string, string[]>()
    for (const m of moved) back.set(parentOf(m.from), [...(back.get(parentOf(m.from)) ?? []), m.to])
    for (const [dir, paths] of back) {
      await run({ op: 'move', paths, to: dir })
      refresh(dir)
    }
    for (const m of moved) refresh(parentOf(m.to))
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(expandHome(path, home))
      toast({ message: 'Path copied' })
    } catch {
      toast({ message: 'Could not copy to the clipboard', kind: 'error' })
    }
  }

  // Drag rows onto a folder or a path-bar step to move them there.
  const canDrop = (target: string) => {
    const paths = dragging.current
    if (!paths?.length || !reachable(target)) return false
    const t = norm(target)
    return paths.every((p) => {
      const a = norm(p)
      return t !== a && !t.startsWith(`${a}/`) && norm(parentOf(p)) !== t
    })
  }

  const dropProps = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDrop(target)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (dropTarget !== target) setDropTarget(target)
    },
    onDragLeave: () => setDropTarget((d) => (d === target ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const paths = dragging.current
      const ok = canDrop(target)
      dragging.current = null
      setDropTarget(null)
      if (!ok || !paths) return
      e.preventDefault()
      void move(paths, target)
    },
  })

  const chatEntries = (dir: string): MenuEntry[] => chatMenu?.(dir) ?? []

  function rowMenu(e: React.MouseEvent, entry: FileEntry) {
    e.preventDefault()
    e.stopPropagation()
    const paths = selected.includes(entry.path) ? selected : [entry.path]
    if (!selected.includes(entry.path)) pick(entry.path)
    const many = paths.length > 1
    const dir = entry.kind === 'dir'
    const items: (MenuEntry | 'sep')[] = []
    if (!many) {
      items.push({ label: 'Open', icon: dir ? <FolderOpen size={14} /> : <ExternalLink size={14} />, run: () => openEntry(entry) })
      if (isMarkdown(entry.name)) items.push({ label: 'Open as note', icon: <FileText size={14} />, run: () => notes.open(entry.path) })
      if (!dir) items.push({ label: 'Open in default app', icon: <ExternalLink size={14} />, run: () => void openDefault(entry.path) })
      items.push(
        { label: 'Open folder in Files', icon: <FolderOpen size={14} />, run: () => void openDefault(dir ? entry.path : parentOf(entry.path)) },
        { label: 'Copy path', icon: <Copy size={14} />, run: () => void copyPath(entry.path) },
        ...(look && !dir && PICTURE_EXT.test(entry.name) ? [{ label: 'Use as background', icon: <ImageIcon size={14} />, run: () => look.pictureFrom(entry.path) }] : []),
        ...(inbox && !dir && !norm(entry.path).startsWith(`${norm(inbox)}/`)
          ? [{ label: 'Send to inbox', icon: <Inbox size={14} />, run: () => context!.sendToInbox(entry.path) }]
          : []),
        ...chatEntries(dir ? entry.path : parentOf(entry.path)),
        'sep',
        { label: 'Rename', icon: <PencilLine size={14} />, run: () => setRenaming(entry.path) },
        { label: 'New folder', icon: <FolderPlus size={14} />, run: () => void create('mkdir', entry) },
        { label: 'New file', icon: <FilePlus size={14} />, run: () => void create('touch', entry) },
        'sep',
      )
    }
    items.push({ label: many ? `Move ${paths.length} items to Trash` : 'Move to Trash', icon: <Trash2 size={14} />, danger: true, run: () => void trash(paths) })
    setMenu({ x: e.clientX, y: e.clientY, entries: items })
  }

  function backgroundMenu(e: React.MouseEvent) {
    e.preventDefault()
    setSelected([])
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: 'New folder', icon: <FolderPlus size={14} />, run: () => void create('mkdir') },
        { label: 'New file', icon: <FilePlus size={14} />, run: () => void create('touch') },
        'sep',
        { label: showHidden ? 'Hide hidden files' : 'Show hidden files', icon: <Eye size={14} />, run: () => setShowHidden((v) => !v) },
        { label: 'Open folder in Files', icon: <FolderOpen size={14} />, run: () => void openDefault(top) },
        ...chatEntries(top),
      ],
    })
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (renaming || e.target !== e.currentTarget) return
    const paths = entryRows.map((r) => r.entry.path)
    const i = current ? paths.indexOf(current.path) : -1
    const go = (j: number) => {
      const p = paths[Math.max(0, Math.min(paths.length - 1, j))]
      if (p) pick(p)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1)
        break
      case 'ArrowUp':
        go(i < 0 ? 0 : i - 1)
        break
      case 'ArrowRight':
        if (current?.kind === 'dir' && !expanded.has(current.path)) toggle(current.path)
        break
      case 'ArrowLeft':
        if (current?.kind === 'dir' && expanded.has(current.path)) toggle(current.path)
        else if (current && byPath.has(parentOf(current.path))) pick(parentOf(current.path))
        break
      case 'Enter':
        if (current) openEntry(current)
        break
      case 'F2':
        if (chosen.length === 1) setRenaming(chosen[0].path)
        break
      case 'Delete':
        void trash(chosen.map((c) => c.path))
        break
      case 'Backspace': {
        const up = parentOf(top)
        if (up !== top && reachable(up)) onNavigate(up)
        break
      }
      case 'a':
        if (!e.ctrlKey) return
        setSelected(paths)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const sortBy = (key: SortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))
  const sortMark = (key: SortKey) => (sort.key === key ? sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : null)

  const topListing = listings[top]
  const steps = segments(top)
  const childCount = (() => {
    if (current?.kind !== 'dir') return undefined
    const l = listings[current.path]
    return l?.status === 'ok' ? l.entries.filter((e) => showHidden || !e.hidden).length : undefined
  })()

  return (
    <div className="files">
      <div className="files-toolbar">
        <nav className="path-bar" aria-label="Path">
          {steps.map((s, i) => (
            <span key={s.path} className="step">
              {i > 0 && <span className="sep">/</span>}
              {i === steps.length - 1 ? (
                <span className="current">{s.name}</span>
              ) : reachable(s.path) ? (
                <button className={cx(dropTarget === s.path && 'drop-into')} onClick={() => onNavigate(s.path)} {...dropProps(s.path)}>
                  {s.name}
                </button>
              ) : (
                <span className="unreachable" title="Outside this profile's folders">
                  {s.name}
                </span>
              )}
            </span>
          ))}
        </nav>
        <label className="filter-box">
          <ListFilter size={13} />
          <input
            value={filter}
            placeholder="Filter by name"
            aria-label="Filter by name"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setFilter('')
                treeRef.current?.focus()
              }
            }}
          />
        </label>
        <button className="icon-btn" onClick={() => void create('mkdir')} title="New folder" aria-label="New folder">
          <FolderPlus size={15} />
        </button>
        <button className="icon-btn" onClick={() => void create('touch')} title="New file" aria-label="New file">
          <FilePlus size={15} />
        </button>
        <button
          className={cx('icon-btn', showHidden && 'on')}
          onClick={() => setShowHidden((v) => !v)}
          title="Show hidden files (Ctrl+H)"
          aria-label="Show hidden files"
          aria-pressed={showHidden}
        >
          <Eye size={15} />
        </button>
        <button className="icon-btn" onClick={() => void openDefault(top)} title="Open in Files" aria-label="Open in Files">
          <FolderOpen size={15} />
        </button>
      </div>

      <div className="files-body">
        <div
          ref={treeRef}
          className="file-tree"
          role="tree"
          aria-label="Files"
          aria-multiselectable
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={backgroundMenu}
        >
          <div className="file-head">
            <button onClick={() => sortBy('name')}>Name {sortMark('name')}</button>
            <button onClick={() => sortBy('size')}>Size {sortMark('size')}</button>
            <button onClick={() => sortBy('mtime')}>Modified {sortMark('mtime')}</button>
          </div>
          {rows.map((row, i) => {
            if (row.kind === 'note') {
              return (
                <div key={`note${i}`} className={cx('file-row note', row.error && 'error')} style={{ '--depth': row.depth } as React.CSSProperties}>
                  <span className="file-name">{row.text}</span>
                </div>
              )
            }
            const { entry, depth, open } = row
            const isSelected = selected.includes(entry.path)
            return (
              <div
                key={entry.path}
                role="treeitem"
                aria-label={entry.name}
                aria-selected={isSelected}
                aria-level={depth + 1}
                aria-expanded={entry.kind === 'dir' ? open : undefined}
                data-path={entry.path}
                className={cx(
                  'file-row',
                  isSelected && 'selected',
                  entry.ignored && 'ignored',
                  entry.hidden && 'hidden-file',
                  dropTarget === entry.path && 'drop-into',
                )}
                style={{ '--depth': depth } as React.CSSProperties}
                title={entry.ignored ? 'Ignored by .gitignore' : undefined}
                draggable={renaming !== entry.path}
                onDragStart={(e) => {
                  const paths = selected.includes(entry.path) ? selected : [entry.path]
                  dragging.current = paths
                  e.dataTransfer.effectAllowed = 'copyMove'
                  e.dataTransfer.setData('text/plain', paths.map((p) => expandHome(p, home)).join('\n'))
                  // Dropped on a chat, the paths are typed into its prompt.
                  e.dataTransfer.setData(PATHS_TYPE, JSON.stringify(paths.map((p) => expandHome(p, home))))
                }}
                onDragEnd={() => {
                  dragging.current = null
                  setDropTarget(null)
                }}
                {...(entry.kind === 'dir' ? dropProps(entry.path) : {})}
                onClick={(e) => onRowClick(e, entry.path)}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(e) => rowMenu(e, entry)}
              >
                <span className="file-name">
                  {entry.kind === 'dir' ? (
                    <ChevronRight
                      size={13}
                      className={cx('file-chevron', open && 'open')}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggle(entry.path)
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="chevron-space" />
                  )}
                  <FileIcon entry={entry} open={open} />
                  {renaming === entry.path ? (
                    <RenameInput name={entry.name} onDone={(v) => void rename(entry.path, v)} />
                  ) : (
                    <span className="label">{entry.name}</span>
                  )}
                  {entry.link && <span className="link-mark" title="Symbolic link">↗</span>}
                </span>
                <span className="file-size">{entry.kind === 'file' ? formatSize(entry.size) : '—'}</span>
                <span className="file-date">{formatDate(entry.mtime)}</span>
              </div>
            )
          })}
          {topListing?.status === 'ok' && entryRows.length === 0 && (
            <div className="file-empty">
              {q ? 'Nothing matches the filter' : topListing.entries.length ? 'Only hidden files here (Ctrl+H shows them)' : 'Empty folder'}
            </div>
          )}
        </div>
        <aside className="file-preview-pane" aria-label="Preview">
          <FilePreview
            entry={chosen.length === 1 ? chosen[0] : null}
            count={chosen.length}
            childCount={childCount}
            onOpen={openEntry}
            onOpenDefault={(p) => void openDefault(p)}
          />
        </aside>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Inline rename: Enter or leaving the field saves, Esc cancels. The name before the extension is selected. */
function RenameInput({ name, onDone }: { name: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  useEffect(() => {
    const el = ref.current!
    el.focus()
    const dot = name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : name.length)
  }, [])
  return (
    <input
      ref={ref}
      className="inline-input rename"
      defaultValue={name}
      aria-label="New name"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
