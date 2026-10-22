import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Blocks, BookOpen, Settings2, ChevronDown, ExternalLink, FilePlus, FolderPlus, GripVertical, IdCard, Inbox, Palette, Pencil, Pin, Play, Plus, Sparkles, Trash2, Workflow, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { chatProgram, CONTEXT_LABEL, entrySlot, itemKey, projectHost, type ContextFolder, type ItemAddr, type ListAddr, type NavItem, type Op, type Profile, type ProfileState } from '../../shared/config-schema.ts'
import { useContextFolders } from '../lib/context.ts'
import type { Connection } from '../lib/events.ts'
import { useLocal } from '../lib/local.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { cx, describeTarget, opensExternally, sameList, type DialogState, type DragData, type DropData, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { EntryIcon } from './EntryIcon.tsx'

export interface NavActions {
  editing: boolean
  selectedKey?: string
  isCollapsed: (key: string, fallback: boolean) => boolean
  toggleCollapsed: (key: string, fallback: boolean) => void
  activate: (addr: ItemAddr, item: NavItem) => void
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  openDialog: (d: DialogState) => void
  openMenu: (m: MenuState) => void
  itemMenu: (addr: ItemAddr, item: NavItem) => (MenuEntry | 'sep')[]
  /** Running chats, and whether one needs you, per project (`project:<path>`) or chat entry. */
  chatMarks: Map<string, { running: number; attention: boolean }>
  notify: (message: string, kind?: 'info' | 'error') => void
}

interface Props extends NavActions {
  profiles: ProfileState[]
  active: ProfileState
  connection: Connection
  setEditing: (v: boolean) => void
  onSwitch: (id: string) => void
  onResizeStart: (e: React.PointerEvent) => void
  onHome: () => void
  /** Open the theme and background panel. */
  onLook: () => void
  /** Open the Claude setup page; `setupActive` while it shows. */
  onSetup: () => void
  setupActive: boolean
  onProfileSettings: () => void
  /** The context folder whose page shows, if one does. */
  contextSelected: ContextFolder | null
}

const Ctx = createContext<NavActions & { profile: Profile; profileId: string; drop: DropHint; renaming: RenameState; showArchive: boolean }>(null!)

const archived = (item: NavItem) => item.type === 'folder' && item.status === 'archived'
const pinned = (item: NavItem) => item.type === 'folder' && !!item.pinned

function countArchived(profile: Profile): number {
  let n = 0
  for (const s of profile.sections) {
    for (const item of s.items) {
      if (archived(item)) n++
      if (item.type === 'group') n += item.items.filter(archived).length
    }
  }
  return n
}

interface DropHint {
  drag: DragData | null
  overId: string | null
}

interface RenameState {
  section: number | null
  start: (section: number | null) => void
}

const sectionId = (i: number) => `sec:${i}`
const itemId = (a: ItemAddr) => `item:${itemKey(a)}`
const listId = (l: ListAddr) => (l.group === undefined ? `list:${l.section}` : `list:${l.section}.${l.group}`)
const collapseKey = (profileId: string, ...parts: string[]) => [profileId, ...parts].join('|')

// The innermost target wins: an entry in a group, a group's list, a top-level
// entry (or a whole group), a heading's list, then the heading itself.
function priority(d: DropData | undefined): number {
  if (!d) return 9
  if (d.kind === 'item') return d.addr.group !== undefined ? 0 : 2
  if (d.kind === 'list') return d.list.group !== undefined ? 1 : 3
  return 4
}

const collision: CollisionDetection = (args) => {
  const a = args.active.data.current as DragData | undefined
  const containers = args.droppableContainers.filter((c) => {
    const d = c.data.current as DropData | undefined
    if (!d || !a) return false
    if (a.kind === 'section') return d.kind === 'section'
    // A group cannot be dropped into a group (including itself).
    if (a.item.type === 'group') {
      if (d.kind === 'item' && d.addr.group !== undefined) return false
      if (d.kind === 'list' && d.list.group !== undefined) return false
    }
    return true
  })
  if (a?.kind === 'section') return closestCenter({ ...args, droppableContainers: containers })
  const hits = pointerWithin({ ...args, droppableContainers: containers })
  if (hits.length) {
    const byId = new Map(containers.map((c) => [c.id, c.data.current as DropData]))
    return [...hits].sort((x, y) => priority(byId.get(x.id)) - priority(byId.get(y.id)))
  }
  return closestCenter({ ...args, droppableContainers: containers })
}

/** Where an entry dropped on `over` should go. */
function dropTarget(over: DropData, profile: Profile): { to: ListAddr; index: number } | null {
  if (over.kind === 'item') return { to: { section: over.addr.section, group: over.addr.group }, index: over.addr.index }
  if (over.kind === 'list') return { to: over.list, index: over.length }
  if (over.kind === 'section') return { to: { section: over.section }, index: profile.sections[over.section]?.items.length ?? 0 }
  return null
}

export function NavPanel(props: Props) {
  const { active, profiles, editing, setEditing, connection, onSwitch, onResizeStart, onHome, onLook, onSetup, setupActive } = props
  const profile = active.profile
  const [drop, setDrop] = useState<DropHint>({ drag: null, overId: null })
  const [renaming, setRenaming] = useState<number | null>(null)
  const [addingHeading, setAddingHeading] = useState(false)
  const [showArchive, setShowArchive] = useLocal('showArchive', false)
  const archivedCount = profile ? countArchived(profile) : 0
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    if (!editing) {
      setRenaming(null)
      setAddingHeading(false)
    }
  }, [editing])

  function onDragEnd(e: DragEndEvent) {
    setDrop({ drag: null, overId: null })
    const a = e.active.data.current as DragData | undefined
    const o = e.over?.data.current as DropData | undefined
    if (!a || !o || !profile) return
    if (a.kind === 'section') {
      if (o.kind === 'section' && o.section !== a.section) {
        void props.run([{ op: 'moveSection', from: a.section, to: o.section }])
      }
      return
    }
    const target = dropTarget(o, profile)
    if (!target) return
    if (a.item.type === 'group' && target.to.group !== undefined) {
      props.notify('A group cannot go inside another group', 'error')
      return
    }
    // Within one list the move is an arrayMove; appending lands on the last slot.
    const finalIndex = o.kind === 'item' ? target.index : target.index - 1
    if (sameList(a.addr, target.to) && finalIndex === a.addr.index) return
    void props.run([{ op: 'moveItem', from: a.addr, to: target.to, index: target.index }])
  }

  const accentOf = (p: ProfileState) => p.profile?.accent ?? '#8a8f98'

  return (
    <nav className={cx('nav', editing && 'editing')} aria-label="Navigation">
      <div className="nav-top">
        <div className="brand">
          <span className="brand-mark" />
          <button className="btn ghost" style={{ height: 22, padding: '0 4px', fontWeight: 600 }} onClick={onHome}>
            WORKBENCH
          </button>
          <span className="spacer" />
          <button className="icon-btn" onClick={onLook} title="Theme and background" aria-label="Theme and background">
            <Palette size={13} />
          </button>
          <button className={cx('icon-btn', setupActive && 'on')} onClick={onSetup} title="Claude setup: skills, MCP servers, agents…" aria-label="Claude setup" aria-pressed={setupActive}>
            <Blocks size={13} />
          </button>
          <button
            className={cx('icon-btn', editing && 'on')}
            onClick={() => setEditing(!editing)}
            disabled={!!active.error}
            title={active.error ? `Fix ${active.id}.yaml first: editing is paused while it has an error` : editing ? 'Done editing (Esc)' : 'Edit navigation'}
            aria-pressed={editing}
            aria-label="Edit navigation"
          >
            <Pencil size={13} />
          </button>
        </div>
        <div className="profile-switch" role="tablist" aria-label="Profile">
          {profiles.map((p, i) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === active.id}
              className={cx(p.id === active.id && 'active')}
              style={{ '--profile-accent': accentOf(p) } as React.CSSProperties}
              onClick={() => onSwitch(p.id)}
              title={`${p.profile?.name ?? p.id} (Ctrl+${i + 1})`}
            >
              {p.profile?.name ?? p.id}
            </button>
          ))}
          <button className="icon-btn profile-gear" onClick={props.onProfileSettings} title="Profile settings" aria-label="Profile settings">
            <Settings2 size={13} />
          </button>
        </div>
      </div>

      {active.error && (
        <div className="banner" role="alert">
          <strong>{active.id}.yaml has an error</strong>
          {active.error.line ? ` on line ${active.error.line}` : ''}. Showing the last good version; editing is paused until
          the file is fixed.
          <span className="mono">{active.error.message}</span>
        </div>
      )}

      <div className="nav-scroll">
        {profile && <ContextBlock selected={props.contextSelected} isCollapsed={props.isCollapsed} toggleCollapsed={props.toggleCollapsed} />}
        {profile && (
          <Ctx.Provider
            value={{
              ...props,
              profile,
              profileId: active.id,
              drop,
              renaming: { section: renaming, start: setRenaming },
              showArchive,
            }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={collision}
              onDragStart={(e) => setDrop({ drag: e.active.data.current as DragData, overId: null })}
              onDragOver={(e) => setDrop((d) => ({ ...d, overId: e.over ? String(e.over.id) : null }))}
              onDragEnd={onDragEnd}
              onDragCancel={() => setDrop({ drag: null, overId: null })}
            >
              <SortableContext items={profile.sections.map((_, i) => sectionId(i))} strategy={verticalListSortingStrategy}>
                {profile.sections.map((s, i) => (
                  <SectionBlock key={sectionId(i)} index={i} title={s.title} items={s.items} collapsedDefault={!!s.collapsed} />
                ))}
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {drop.drag && (
                  <div className="drag-overlay">
                    {drop.drag.kind === 'section' ? (
                      <span style={{ textTransform: 'uppercase', fontSize: 11, letterSpacing: '0.08em' }}>{drop.drag.title}</span>
                    ) : (
                      <>
                        <EntryIcon type={drop.drag.item.type} icon={drop.drag.item.icon} />
                        {drop.drag.item.label}
                      </>
                    )}
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </Ctx.Provider>
        )}

        {!editing && archivedCount > 0 && (
          <button className="archive-toggle" onClick={() => setShowArchive((v) => !v)} aria-pressed={showArchive}>
            {archivedCount} archived · {showArchive ? 'Hide' : 'Show'}
          </button>
        )}

        {editing && profile && !active.error && (
          addingHeading ? (
            <div style={{ margin: '12px 12px 0', display: 'flex' }}>
              <InlineInput
                initial=""
                placeholder="Heading title"
                onDone={(title) => {
                  setAddingHeading(false)
                  if (title) void props.run([{ op: 'addSection', title }])
                }}
              />
            </div>
          ) : (
            <button className="add-heading" onClick={() => setAddingHeading(true)}>
              <Plus size={14} /> Add heading
            </button>
          )
        )}
      </div>

      <div className="nav-footer">
        <span className={cx('dot', connection)} title={`Service: ${connection}`} />
        <span style={{ flex: 1 }}>
          {connection === 'offline'
            ? 'Service offline, retrying'
            : connection === 'connecting'
              ? 'Connecting'
              : editing
                ? 'Drag to reorder · right-click for more · Esc when done'
                : `${active.id}.yaml`}
        </span>
      </div>

      <div className="resize-handle" onPointerDown={onResizeStart} role="separator" aria-orientation="vertical" aria-label="Resize navigation" />
    </nav>
  )
}

function InlineInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v === null ? null : v.trim() || null)
  }
  return (
    <input
      className="inline-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  )
}

function useDropHint(id: string, kind: 'before' | 'into') {
  const { drop } = useContext(Ctx)
  if (!drop.drag || drop.overId !== id) return null
  if (kind === 'into') return 'drop-into'
  // Inside one list the sortable animation already shows the gap.
  if (drop.drag.kind === 'item' && drop.overId.startsWith('item:')) {
    const over = drop.overId.slice(5).split('.')
    const from = itemKey(drop.drag.addr).split('.')
    if (over.slice(0, -1).join('.') === from.slice(0, -1).join('.')) return null
  }
  return drop.drag.kind === 'item' ? 'drop-before' : null
}

function SectionBlock({ index, title, items, collapsedDefault }: { index: number; title: string; items: NavItem[]; collapsedDefault: boolean }) {
  const ctx = useContext(Ctx)
  const { editing, profileId, renaming } = ctx
  const id = sectionId(index)
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id,
    data: { kind: 'section', section: index, title } satisfies DropData,
    disabled: !editing,
  })
  const hint = useDropHint(id, 'into')
  const key = collapseKey(profileId, title)
  const open = !ctx.isCollapsed(key, collapsedDefault)
  const toggle = () => ctx.toggleCollapsed(key, collapsedDefault)
  const context = `Under ${title}`

  const addEntry = () => ctx.openDialog({ mode: 'add', list: { section: index }, context })
  const remove = () => ctx.run([{ op: 'deleteSection', section: index }], `Deleted heading "${title}"`)

  const menu = (e: React.MouseEvent) => {
    e.preventDefault()
    ctx.openMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: 'Add entry…', icon: <Plus size={14} />, run: addEntry },
        { label: 'New note…', icon: <FilePlus size={14} />, run: () => ctx.openDialog({ mode: 'note', list: { section: index }, context }) },
        { label: 'Add group…', icon: <Plus size={14} />, run: () => ctx.openDialog({ mode: 'add', list: { section: index }, context, presetType: 'group' }) },
        { label: 'Rename heading', icon: <Pencil size={14} />, run: () => renaming.start(index) },
        {
          label: 'Add heading below',
          icon: <Plus size={14} />,
          run: async () => {
            if (await ctx.run([{ op: 'addSection', title: 'New heading', index: index + 1 }])) renaming.start(index + 1)
          },
        },
        'sep',
        { label: 'Delete heading', icon: <Trash2 size={14} />, danger: true, run: remove },
      ],
    })
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('section', isDragging && 'dragging', hint)}
    >
      <div className="section-head" onContextMenu={menu}>
        {editing && (
          <span className="icon-btn drag-handle" {...attributes} {...listeners} aria-label={`Drag heading ${title}`}>
            <GripVertical size={13} />
          </span>
        )}
        <ChevronDown size={13} className={cx('chevron', !open && 'closed')} onClick={toggle} />
        {renaming.section === index ? (
          <InlineInput
            initial={title}
            onDone={(value) => {
              renaming.start(null)
              if (value && value !== title) void ctx.run([{ op: 'renameSection', section: index, title: value }])
            }}
          />
        ) : (
          <span className="title" onClick={toggle} onDoubleClick={() => editing && renaming.start(index)}>
            {title}
          </span>
        )}
        {!open && items.length > 0 && <span className="count">{items.length}</span>}
        <span className="row-actions">
          <button className="icon-btn" onClick={addEntry} title="Add entry" aria-label={`Add entry to ${title}`}>
            <Plus size={13} />
          </button>
          <button className="icon-btn" onClick={() => renaming.start(index)} title="Rename heading" aria-label={`Rename ${title}`}>
            <Pencil size={12} />
          </button>
          <button className="icon-btn danger" onClick={remove} title="Delete heading" aria-label={`Delete ${title}`}>
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      {open && <ItemList list={{ section: index }} items={items} />}
    </div>
  )
}

const CONTEXT_ICON: Record<ContextFolder, LucideIcon> = { context: IdCard, knowledge: BookOpen, processes: Workflow, inbox: Inbox }

/**
 * The profile's context folders, a fixed heading above the configured ones:
 * not part of the YAML, so never dragged or edited. Before it is set up, one
 * row offers to set it up.
 */
function ContextBlock({
  selected,
  isCollapsed,
  toggleCollapsed,
}: {
  selected: ContextFolder | null
  isCollapsed: Props['isCollapsed']
  toggleCollapsed: Props['toggleCollapsed']
}) {
  const ctx = useContextFolders()
  const notes = useNotes()
  const status = ctx?.status
  if (!ctx || !status) return null
  const open = !isCollapsed('context', false)
  const toggle = () => toggleCollapsed('context', false)
  return (
    <div className="section context-section" role="group" aria-label="Context">
      <div className="section-head">
        <ChevronDown size={13} className={cx('chevron', !open && 'closed')} onClick={toggle} />
        <span className="title" onClick={toggle}>
          Context
        </span>
        {!open && status.inbox > 0 && <span className="count" title="In the inbox">{status.inbox}</span>}
      </div>
      {open && (
        <div className="items">
          {status.ready ? (
            status.folders.map((f) => {
              const Icon = CONTEXT_ICON[f.name]
              const on = selected === f.name
              return (
                <div
                  key={f.name}
                  role="link"
                  tabIndex={0}
                  className={cx('item', on && 'selected', !f.exists && 'missing')}
                  aria-current={on ? 'page' : undefined}
                  title={f.exists ? f.path : `${f.path} (not there)`}
                  onClick={() => ctx.open(f.name)}
                  onKeyDown={(e) => e.key === 'Enter' && ctx.open(f.name)}
                >
                  <Icon size={15} className="icon" />
                  <span className="label">{CONTEXT_LABEL[f.name]}</span>
                  {f.name === 'inbox' && status.inbox > 0 && (
                    <span className="inbox-count" aria-label={`${status.inbox} in the inbox`}>
                      {status.inbox}
                    </span>
                  )}
                </div>
              )
            })
          ) : (
            <button className="item context-setup" onClick={() => ctx.setup()} title="Creates context, knowledge, processes and inbox with starter notes">
              <FolderPlus size={15} className="icon" />
              <span className="label">Set up context in {status.notes ?? notes.suggestedRoot}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ItemList({ list, items }: { list: ListAddr; items: NavItem[] }) {
  const { editing, showArchive } = useContext(Ctx)
  const id = listId(list)
  const { setNodeRef } = useDroppable({ id, data: { kind: 'list', list, length: items.length } satisfies DropData, disabled: !editing })
  const hint = useDropHint(id, 'into')
  // Pinned projects first and archived ones hidden, except while editing, where
  // the file's own order shows so a drag lands where it looks like it will.
  const rows = items.map((item, index) => ({ item, index }))
  const shown = editing ? rows : rows.filter((r) => showArchive || !archived(r.item)).sort((a, b) => Number(pinned(b.item)) - Number(pinned(a.item)))
  const ids = shown.map((r) => itemId({ ...list, index: r.index }))
  return (
    <div ref={setNodeRef} className={cx('items', hint)}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {shown.map(({ item, index }, i) => {
          const addr = { ...list, index }
          return item.type === 'group' ? (
            <GroupBlock key={ids[i]} addr={addr} item={item} />
          ) : (
            <ItemRow key={ids[i]} addr={addr} item={item} />
          )
        })}
      </SortableContext>
      {editing && items.length === 0 && (
        <div className="empty-drop">{list.group === undefined ? 'Empty: add an entry or drop one here' : 'Drop entries here'}</div>
      )}
    </div>
  )
}

function useItemSortable(addr: ItemAddr, item: NavItem) {
  const { editing } = useContext(Ctx)
  const id = itemId(addr)
  const sortable = useSortable({ id, data: { kind: 'item', addr, item } satisfies DropData, disabled: !editing })
  const hint = useDropHint(id, 'before')
  return { ...sortable, hint, style: { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition } }
}

function RowActions({ addr, item }: { addr: ItemAddr; item: NavItem }) {
  const ctx = useContext(Ctx)
  const section = ctx.profile.sections[addr.section]
  const context =
    addr.group === undefined ? `Under ${section?.title}` : `Under ${section?.title} / ${section?.items[addr.group]?.label}`
  return (
    <span className="row-actions">
      {item.type === 'group' && (
        <button
          className="icon-btn"
          title="Add entry to group"
          aria-label={`Add entry to ${item.label}`}
          onClick={(e) => {
            e.stopPropagation()
            ctx.openDialog({ mode: 'add', list: { section: addr.section, group: addr.index }, context: `Under ${section?.title} / ${item.label}` })
          }}
        >
          <Plus size={13} />
        </button>
      )}
      <button
        className="icon-btn"
        title="Edit"
        aria-label={`Edit ${item.label}`}
        onClick={(e) => {
          e.stopPropagation()
          ctx.openDialog({ mode: 'edit', at: addr, item, context })
        }}
      >
        <Pencil size={12} />
      </button>
      <button
        className="icon-btn danger"
        title="Delete"
        aria-label={`Delete ${item.label}`}
        onClick={(e) => {
          e.stopPropagation()
          void ctx.run([{ op: 'deleteItem', at: addr }], `Deleted "${item.label}"`)
        }}
      >
        <Trash2 size={12} />
      </button>
    </span>
  )
}

function ItemRow({ addr, item }: { addr: ItemAddr; item: NavItem }) {
  const ctx = useContext(Ctx)
  const { setNodeRef, attributes, listeners, isDragging, hint, style } = useItemSortable(addr, item)
  // Launchers and links open outside the app only from their button; the name is just text.
  const outside = opensExternally(item)
  const selected = ctx.selectedKey === itemKey(addr) && !outside
  const section = ctx.profile.sections[addr.section]
  const context = addr.group === undefined ? `Under ${section?.title}` : `Under ${section?.title} / ${section?.items[addr.group]?.label}`

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx('item', selected && 'selected', isDragging && 'dragging', archived(item) && 'archived', outside && !ctx.editing && 'outside', hint)}
      title={item.type === 'folder' && item.description ? `${item.description}\n${describeTarget(item)}` : describeTarget(item)}
      aria-current={selected ? 'page' : undefined}
      onClick={() => {
        if (ctx.editing) ctx.openDialog({ mode: 'edit', at: addr, item, context })
        else if (!outside) ctx.activate(addr, item)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        ctx.openMenu({ x: e.clientX, y: e.clientY, entries: ctx.itemMenu(addr, item) })
      }}
    >
      {ctx.editing && (
        <span className="icon-btn drag-handle" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} aria-label={`Drag ${item.label}`}>
          <GripVertical size={13} />
        </span>
      )}
      <EntryIcon type={item.type} icon={item.icon} agent={item.type === 'chat' ? chatProgram(item.agent) : undefined} />
      <span className="label">{item.label}</span>
      {!ctx.editing && outside && (
        <button
          className="open-btn"
          aria-label={`${item.type === 'launch' ? 'Start' : 'Open'} ${item.label}`}
          title={item.type === 'launch' ? 'Start' : 'Open in the browser'}
          onClick={(e) => {
            e.stopPropagation()
            ctx.activate(addr, item)
          }}
        >
          {item.type === 'launch' ? <Play size={11} /> : <ExternalLink size={11} />}
        </button>
      )}
      {!ctx.editing && <ChatMark item={item} />}
      {!ctx.editing && item.type === 'folder' && (
        <span className="project-marks">
          {item.pinned && <Pin size={11} className="pin-mark" aria-label="Pinned" />}
          <span className={cx('status-dot', item.status ?? 'active')} title={item.status ?? 'active'} />
        </span>
      )}
      <RowActions addr={addr} item={item} />
    </div>
  )
}

/** A spark on a project or chat entry with running chats (with a count past one); the accent colour when one needs you. */
function ChatMark({ item }: { item: NavItem }) {
  const { chatMarks } = useContext(Ctx)
  const key = item.type === 'folder' ? projectHost(item.path) : item.type === 'chat' ? entrySlot(item) : null
  const mark = key ? chatMarks.get(key) : undefined
  if (!mark || (!mark.running && !mark.attention)) return null
  const what = `${mark.running} running ${mark.running === 1 ? 'chat' : 'chats'}${mark.attention ? ', one needs you' : ''}`
  return (
    <span className={cx('chat-mark', mark.attention && 'attention', item.type !== 'folder' && 'alone')} title={what} aria-label={what}>
      <Sparkles size={11} />
      {mark.running > 1 && mark.running}
    </span>
  )
}

function GroupBlock({ addr, item }: { addr: ItemAddr; item: Extract<NavItem, { type: 'group' }> }) {
  const ctx = useContext(Ctx)
  const { setNodeRef, attributes, listeners, isDragging, hint, style } = useItemSortable(addr, item)
  const section = ctx.profile.sections[addr.section]
  const key = collapseKey(ctx.profileId, section?.title ?? '', item.label)
  const open = !ctx.isCollapsed(key, !!item.collapsed)

  return (
    <div ref={setNodeRef} style={style} className={cx(isDragging && 'dragging')}>
      <div
        className={cx('item', hint)}
        title={describeTarget(item)}
        onClick={() => ctx.toggleCollapsed(key, !!item.collapsed)}
        onContextMenu={(e) => {
          e.preventDefault()
          ctx.openMenu({ x: e.clientX, y: e.clientY, entries: ctx.itemMenu(addr, item) })
        }}
      >
        {ctx.editing && (
          <span className="icon-btn drag-handle" {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} aria-label={`Drag ${item.label}`}>
            <GripVertical size={13} />
          </span>
        )}
        <ChevronDown size={13} className={cx('chevron', !open && 'closed')} style={{ marginLeft: -4 }} />
        <EntryIcon type="group" icon={item.icon} />
        <span className="label">{item.label}</span>
        {!open && item.items.length > 0 && <span className="kind">{item.items.length}</span>}
        <RowActions addr={addr} item={item} />
      </div>
      {open && (
        <div className="group-children">
          <ItemList list={{ section: addr.section, group: addr.index }} items={item.items} />
        </div>
      )}
    </div>
  )
}
