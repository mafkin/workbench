// The chats dock (part 12): every chat of the profile as a column of tabs
// beside the page, the active one's terminal under them. New chat starts
// where you are (the item shown, else the drawer's folder) and the chat
// remembers that page; History lists the Claude sessions there. Collapsed, it
// is a strip with the count and the needs-you dot.
import { ChevronDown, ChevronsLeft, ChevronsRight, FastForward, History, MessageSquarePlus, MessagesSquare, Palette, Pencil, Pin, PinOff, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { CHAT_COLORS, chatName, normalizePath, type Chat, type ItemAddr, type Profile } from '../../shared/config-schema.ts'
import { carriesPaths, COLOR_NAMES, droppedPaths, pasteInto, quotePaths, slotStep, useChats } from '../lib/chats.ts'
import { cx, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { ago } from '../lib/recent.ts'
import { agentEntries } from './AgentMenu.tsx'
import { ChatPane } from './ChatPane.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { agentIcon } from './EntryIcon.tsx'
import { InlineField } from './ProjectView.tsx'

/** Where New chat starts: the item shown (its page and folder), else the drawer's own folder. */
export type DockContext = { kind: 'item'; addr: ItemAddr; label: string; base: string; agent?: string } | { kind: 'drawer'; drawer: number; label: string; base: string }

interface Props {
  profile: Profile
  context: DockContext
  open: boolean
  setOpen: (open: boolean) => void
  /** Chats with no page of their own (entries' chats have their page). */
  active: Chat | null
  select: (chat: Chat) => void
}

/** A step's or entry's chat goes by its step or entry; the rest by their own name. */
const nameOf = (chat: Chat) => chat.label ?? (chat.slot ? slotStep(chat.slot) : chatName(chat))

export function ChatsDock({ profile, context, open, setOpen, active, select }: Props) {
  const chats = useChats()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropChat, setDropChat] = useState<string | null>(null)
  // Pinned first, then the newest; a step's or entry's chat shows with the rest.
  const list = [...chats.list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  const attention = list.some((c) => c.attention)
  const running = list.filter((c) => c.state === 'running').length

  const startHere = (agent?: string, resume?: string, path?: string) =>
    context.kind === 'item' ? chats.start({ at: context.addr, agent, resume, path }) : chats.start({ drawer: context.drawer, agent, resume, path })

  const newChat = async (agent?: string) => {
    const chat = await startHere(agent)
    if (chat) select(chat)
  }

  const menuBelow = (e: React.MouseEvent, entries: (MenuEntry | 'sep')[]) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 4, entries })
  }

  const startMenu = (e: React.MouseEvent) =>
    menuBelow(e, agentEntries(profile.agents, { current: context.kind === 'item' ? context.agent : undefined, shell: true, run: (a) => void newChat(a), edit: () => chats.editAgents(context.base) }))

  // Earlier Claude sessions where New chat would start; one already open is shown, not started twice.
  const historyMenu = async (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const sessions = await chats.history(context.base)
    const openOnes = new Map(chats.list.filter((c) => c.session).map((c) => [c.session, c]))
    const entries: MenuEntry[] = sessions.slice(0, 15).map((s) => ({
      label: s.title,
      detail: `${normalizePath(s.cwd) === normalizePath(context.base) ? '' : `${s.cwd} · `}${openOnes.has(s.id) ? 'open' : ago(s.mtime)}`,
      run: () => {
        const chat = openOnes.get(s.id)
        if (chat) return chats.open(chat)
        void startHere(undefined, s.id, s.cwd).then((c) => c && select(c))
      },
    }))
    setMenu({ x: r.left, y: r.bottom + 4, entries: entries.length ? entries : [{ label: `No Claude sessions in ${context.base} yet`, disabled: true, run() {} }] })
  }

  const handoff = async (chat: Chat) => {
    const next = await chats.handoff(chat)
    if (next) select(next)
  }

  function chatMenu(e: React.MouseEvent, chat: Chat) {
    e.preventDefault()
    e.stopPropagation()
    const at = { x: e.clientX, y: e.clientY }
    const colours: (MenuEntry | 'sep')[] = [
      ...CHAT_COLORS.map((c, i) => ({ label: COLOR_NAMES[i] ?? c, icon: <span className="category-dot" style={{ background: c }} />, run: () => void chats.update(chat, { color: c }) })),
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
      select(chat)
    },
  })

  if (!open) {
    return (
      <aside className="dock collapsed" aria-label="Chats">
        <button className="dock-strip" onClick={() => setOpen(true)} title="Show the chats (Ctrl+J)" aria-label={`Show chats (${list.length})`}>
          <ChevronsLeft size={14} />
          <MessagesSquare size={16} />
          {list.length > 0 && <span className={cx('dock-count', running > 0 && 'live')}>{list.length}</span>}
          {attention && <span className="attention" aria-label="A chat needs you" />}
        </button>
      </aside>
    )
  }

  return (
    <aside className="dock" aria-label="Chats">
      <div className="dock-head">
        <span className="dock-title">Chats</span>
        <span className="spacer" />
        <button className="tab-action" onClick={() => void newChat()} title={`Start ${context.kind === 'item' ? (context.agent ?? 'Claude') : 'Claude'} in ${context.base} (${context.label})`}>
          <MessageSquarePlus size={14} />
          New chat
        </button>
        <button className="tab-action more" aria-label="More kinds of chat" onClick={startMenu}>
          <ChevronDown size={13} />
        </button>
        <button className="tab-action" onClick={(e) => void historyMenu(e)} title={`Earlier Claude sessions in ${context.base}`}>
          <History size={14} />
          History
        </button>
        <button className="icon-btn" onClick={() => setOpen(false)} title="Hide the chats (Ctrl+J)" aria-label="Hide chats">
          <ChevronsRight size={14} />
        </button>
      </div>
      <div className="dock-tabs" role="tablist" aria-label="Chats" aria-orientation="vertical">
        {list.length === 0 && <p className="dock-empty">No chats yet. New chat starts one in {context.label}.</p>}
        {list.map((chat) => {
          const on = active?.id === chat.id
          const Icon = agentIcon(chat.agent)
          return (
            <div
              key={chat.id}
              role="tab"
              tabIndex={0}
              aria-selected={on}
              className={cx('dock-tab chat-tab', on && 'active', chat.color && 'colored', dropChat === chat.id && 'dropping', chat.state !== 'running' && 'idle')}
              style={chat.color ? ({ '--chat': chat.color } as React.CSSProperties) : undefined}
              title={[nameOf(chat), chat.agentProfile, chat.cwd, chat.page ? `from ${chat.page}` : null].filter(Boolean).join(' · ')}
              onClick={() => select(chat)}
              onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && select(chat)}
              onContextMenu={(e) => chatMenu(e, chat)}
              {...chatDrop(chat)}
            >
              <Icon size={14} className="icon" />
              {renaming === chat.id ? (
                <InlineField
                  initial={nameOf(chat)}
                  label="Chat name"
                  onDone={(v) => {
                    setRenaming(null)
                    if (v !== null) void chats.update(chat, { label: v || null })
                  }}
                />
              ) : (
                <span className="chat-name">{nameOf(chat)}</span>
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
      </div>
      <div className="dock-body">
        {active ? <ChatPane key={active.id} chat={active} /> : <p className="dock-empty">Pick a chat, or start one.</p>}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
