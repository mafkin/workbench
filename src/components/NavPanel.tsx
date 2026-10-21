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
import { ArrowUpRight, ChevronDown, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { itemKey, type ItemAddr, type ListAddr, type NavItem, type Op, type Profile, type ProfileState } from '../../shared/config-schema.ts'
import type { Connection } from '../lib/events.ts'
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
}

const Ctx = createContext<NavActions & { profile: Profile; profileId: string; drop: DropHint; renaming: RenameState }>(null!)

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
  const { active, profiles, editing, setEditing, connection, onSwitch, onResizeStart, onHome } = props
  const profile = active.profile
  const [drop, setDrop] = useState<DropHint>({ drag: null, overId: null })
  const [renaming, setRenaming] = useState<number | null>(null)
  const [addingHeading, setAddingHeading] = useState(false)
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
          <button
            className={cx('icon-btn', editing && 'on')}
            onClick={() => setEditing(!editing)}
            title={editing ? 'Done editing (Esc)' : 'Edit navigation'}
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
        {profile && (
          <Ctx.Provider
            value={{
              ...props,
              profile,
              profileId: active.id,
              drop,
              renaming: { section: renaming, start: setRenaming },
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

function ItemList({ list, items }: { list: ListAddr; items: NavItem[] }) {
  const { editing } = useContext(Ctx)
  const id = listId(list)
  const { setNodeRef } = useDroppable({ id, data: { kind: 'list', list, length: items.length } satisfies DropData, disabled: !editing })
  const hint = useDropHint(id, 'into')
  const ids = items.map((_, i) => itemId({ ...list, index: i }))
  return (
    <div ref={setNodeRef} className={cx('items', hint)}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {items.map((item, i) => {
          const addr = { ...list, index: i }
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
  const selected = ctx.selectedKey === itemKey(addr) && !opensExternally(item)
  const section = ctx.profile.sections[addr.section]
  const context = addr.group === undefined ? `Under ${section?.title}` : `Under ${section?.title} / ${section?.items[addr.group]?.label}`

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx('item', selected && 'selected', isDragging && 'dragging', hint)}
      title={describeTarget(item)}
      aria-current={selected ? 'page' : undefined}
      onClick={() => (ctx.editing ? ctx.openDialog({ mode: 'edit', at: addr, item, context }) : ctx.activate(addr, item))}
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
      <EntryIcon type={item.type} icon={item.icon} />
      <span className="label">{item.label}</span>
      {!ctx.editing && opensExternally(item) && <ArrowUpRight size={12} className="kind" />}
      <RowActions addr={addr} item={item} />
    </div>
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
