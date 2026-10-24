import { expandHome, normalizePath, profileFile } from '../../shared/config-schema.ts'
import { ArrowLeft, CalendarDays, ExternalLink, FileText, Folder, Pencil, X } from 'lucide-react'
import { lazy, Suspense } from 'react'
import {
  chatName,
  chatProgram,
  allSections,
  drawersOf,
  entryAt,
  entrySlot,
  folderRoots,
  getItem,
  NOTE_EXT,
  projectHost,
  projectRef,
  sectionsOf,
  stepsOf,
  type Chat,
  type ItemAddr,
  type NavItem,
  type Profile,
  type ProfileState,
  type SearchHit,
  type ServersScan,
} from '../../shared/config-schema.ts'
import { useChats } from '../lib/chats.ts'
import { nameOf } from '../lib/files.ts'
import { findEntry, FILES_KEY, NOTE_KEY, parseKey, RAIL_LABEL, resolveEntry, type RailTool, type Selection } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { ago, type Recent } from '../lib/recent.ts'
import { ChatPane } from './ChatPane.tsx'
import { ContextView } from './ContextView.tsx'
import { DailyView } from './DailyView.tsx'
import { agentIcon, EntryIcon, TYPE_LABEL } from './EntryIcon.tsx'
import { FileBrowser } from './FileBrowser.tsx'
import { NotesFolderHint } from './NotesFolderHint.tsx'
import { NoteView } from './NoteView.tsx'
import { ProjectView, type ProjectActions } from './ProjectView.tsx'
import { SearchView } from './SearchView.tsx'
import type { ToastInput } from './Toast.tsx'

const ClaudeSetupView = lazy(() => import('./ClaudeSetupView.tsx'))
const ServersView = lazy(() => import('./ServersView.tsx'))
const GitView = lazy(() => import('./GitView.tsx'))
const DrawerDialog = lazy(() => import('./DrawerDialog.tsx').then((m) => ({ default: m.DrawerDialog })))

export interface SearchState {
  open: boolean
  query: string
}

interface Props {
  active: ProfileState
  selected: Selection | null
  search: SearchState
  setSearch: (s: SearchState) => void
  /** The first search hit, which Enter in the nav's search box opens. */
  firstHit: React.RefObject<string | null>
  canGoBack: boolean
  onBack: () => void
  /** Open a folder in the browser; one that is a folder entry opens as that entry. */
  openFolder: (path: string) => void
  toast: (t: ToastInput) => void
  home: string
  onHome: () => void
  activate: (addr: ItemAddr, item: NavItem) => void
  openExternally: (addr: ItemAddr, item: NavItem) => void
  startEditing: () => void
  actions: ProjectActions
  /** Recently opened, newest first, for Home. */
  recent: Recent[]
  openRecent: (r: Recent) => void
  /** The Servers page's checks, so the nav's marks follow it. */
  onServersScan: (scan: ServersScan) => void
  /** The drawer the nav shows. */
  drawer: number
  /** The rail's Drawer settings: show a drawer by name (renamed), or go home after a delete. */
  onDrawerShow: (name: string) => void
  onDrawerDeleted: () => void
}

const noteName = (path: string) => (path.split('/').pop() ?? path).replace(NOTE_EXT, '')

export function MainPane(props: Props) {
  const { active, selected, search, setSearch, firstHit, canGoBack, onBack, activate, startEditing } = props
  const profile = active.profile
  const entry = selected?.kind === 'entry' ? selected : null
  // The heading the entry sits under (a shared entry's original, in its own drawer), for the page's kicker.
  const section = entry && profile ? sectionsOf(profile, entry.origin.drawer ?? 0)[entry.origin.section] : undefined

  return (
    <main className="main">
      {canGoBack && (
        <button className="icon-btn back-float" onClick={onBack} title="Back (Alt+←)" aria-label="Back">
          <ArrowLeft size={15} />
        </button>
      )}
      <div className="content">
        {!profile ? (
          <BrokenProfile active={active} />
        ) : search.open ? (
          <SearchView query={search.query} onQuery={(query) => setSearch({ open: true, query })} onResults={(hits: SearchHit[]) => (firstHit.current = hits[0]?.path ?? null)} />
        ) : entry ? (
          <EntryView
            key={`${active.id}:${entry.item.label}`}
            addr={entry.origin}
            item={entry.item}
            kicker={section?.title ?? ''}
            pane={props}
          />
        ) : selected?.kind === 'note' ? (
          <PathNote key={selected.path} path={selected.path} />
        ) : selected?.kind === 'files' ? (
          <Browser key={`${active.id}:${selected.path}`} top={selected.path} kicker="Files" heading={nameOf(selected.path)} pane={props} />
        ) : selected?.kind === 'chat' ? (
          <LoneChat key={selected.id} id={selected.id} />
        ) : selected?.kind === 'context' ? (
          <ContextView key={`${active.id}:${selected.name}`} name={selected.name} profileId={active.id} profile={profile} home={props.home} openFolder={props.openFolder} toast={props.toast} />
        ) : selected?.kind === 'servers' ? (
          <Suspense fallback={null}>
            <ServersView key={active.id} profileId={active.id} onScan={props.onServersScan} toast={props.toast} />
          </Suspense>
        ) : selected?.kind === 'rail' ? (
          <RailView key={`${active.id}:${props.drawer}:${selected.tool}`} tool={selected.tool} pane={props} />
        ) : (
          <Home active={active} drawer={props.drawer} activate={activate} recent={props.recent} openRecent={props.openRecent} startEditing={startEditing} />
        )}
      </div>
    </main>
  )
}

function BrokenProfile({ active }: { active: ProfileState }) {
  return (
    <div className="empty-state">
      <h2 style={{ color: 'var(--text)' }}>{profileFile(active)} cannot be read</h2>
      <p>
        {active.error?.line ? `Line ${active.error.line}: ` : ''}
        {active.error?.message}
      </p>
      <p>Fix the file and Workbench reloads it automatically.</p>
    </div>
  )
}

/** Home: what you opened last, and today's note. The nav is on the left, so it is not repeated here. */
function Home({
  active,
  drawer,
  activate,
  recent,
  openRecent,
  startEditing,
}: {
  active: ProfileState
  drawer: number
  activate: Props['activate']
  recent: Recent[]
  openRecent: Props['openRecent']
  startEditing: () => void
}) {
  const profile = active.profile!

  if (sectionsOf(profile, drawer).length === 0) {
    return (
      <div className="empty-state">
        <h2 style={{ color: 'var(--text)' }}>No headings yet</h2>
        <p>Add headings for each category of work, then entries under them.</p>
        <button className="btn primary" onClick={startEditing}>
          <Pencil size={14} /> Edit navigation
        </button>
      </div>
    )
  }

  const dailyAddr = findEntry(profile, 'daily', undefined, drawer)
  const daily = dailyAddr ? getItem(profile, dailyAddr) : undefined
  const rows = recent.flatMap((r) => {
    const row = describeRecent(profile, r)
    return row ? [{ r, ...row }] : []
  })
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="page home-page">
      <div className="page-kicker">Profile</div>
      <h1 className="page-title">{profile.name}</h1>
      {!profile.notes && <NotesFolderHint compact />}
      {dailyAddr && daily && (
        <button className="today-card" onClick={() => activate(dailyAddr, daily)}>
          <CalendarDays size={18} className="icon" />
          <span>
            <strong>{daily.label}</strong>
            <span>{today}</span>
          </span>
        </button>
      )}
      <OtherChats profile={profile} />
      <h2 className="section-label">Recent</h2>
      {rows.length === 0 ? (
        <p className="none">Nothing opened yet. Pick a project on the left.</p>
      ) : (
        <ul className="recent-list">
          {rows.map(({ r, icon, label, where }) => (
            <li key={`${r.key}|${r.step ?? ''}`}>
              <button onClick={() => openRecent(r)}>
                {icon}
                <span className="label">{label}</span>
                <span className="where">{where}</span>
                <span className="when">{ago(r.at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Chats whose project or chat entry is gone (removed, or its path changed), so none runs out of sight. */
function OtherChats({ profile }: { profile: Profile }) {
  const chats = useChats()
  const hosts = new Set<string>()
  const visit = (item: NavItem) => {
    if (item.type === 'folder') hosts.add(projectHost(projectRef(item)))
    if (item.type === 'chat') hosts.add(entrySlot(item))
    if (item.type === 'group') item.items.forEach(visit)
  }
  for (const s of allSections(profile)) s.items.forEach(visit)
  const others = chats.list.filter((c) => !hosts.has(c.host))
  if (!others.length) return null
  return (
    <>
      <h2 className="section-label">Other chats</h2>
      <ul className="recent-list other-chats">
        {others.map((c) => {
          const Icon = agentIcon(c.agent)
          return (
            <li key={c.id}>
              <button onClick={() => chats.open(c)}>
                <Icon size={15} className="icon" />
                <span className="label">{chatName(c)}</span>
                <span className="where">{c.cwd}</span>
                <span className="when">{c.state === 'running' ? 'running' : c.state}</span>
              </button>
              <button className="icon-btn" aria-label={`Close ${chatName(c)}`} title="Close" onClick={() => chats.close(c)}>
                <X size={13} />
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** A chat on its own page: one whose project or entry is gone. */
function LoneChat({ id }: { id: string }) {
  const chats = useChats()
  const chat = chats.list.find((c) => c.id === id)
  if (!chats.loaded) return null
  if (!chat) return <div className="empty-state">This chat has been closed.</div>
  return <ChatPage chat={chat} kicker="Chat" />
}

function ChatPage({ chat, kicker, start, historyPath, title }: { chat: Chat | null; kicker: string; start?: (resume?: string) => Promise<Chat | null>; historyPath?: string; title?: React.ReactNode }) {
  return (
    <div className="page wide chat-page">
      <div className="page-kicker">{kicker}</div>
      <h1 className="page-title">{title ?? (chat ? chatName(chat) : '')}</h1>
      <ChatPane chat={chat} start={start} historyPath={historyPath} />
    </div>
  )
}

/** How a recent item reads now; null when it no longer exists (an address that now holds another entry). */
function describeRecent(profile: NonNullable<ProfileState['profile']>, r: Recent): { icon: React.ReactNode; label: string; where: string } | null {
  if (r.key.startsWith(NOTE_KEY)) {
    const p = r.key.slice(NOTE_KEY.length)
    return { icon: <FileText size={15} className="icon" />, label: noteName(p), where: p }
  }
  if (r.key.startsWith(FILES_KEY)) {
    const p = r.key.slice(FILES_KEY.length)
    return { icon: <Folder size={15} className="icon" />, label: nameOf(p), where: p }
  }
  // Older items have no identity: the address must still hold the same label.
  const addr = r.entry ? resolveEntry(profile, r.key, r.entry) : parseKey(r.key)
  const own = addr ? getItem(profile, addr) : undefined
  const item = addr ? entryAt(profile, addr)?.item : undefined
  if (!addr || !own || !item || (!r.entry && own.label !== r.label)) return null
  const section = sectionsOf(profile, addr.drawer ?? 0)[addr.section]
  const group = addr.group !== undefined ? section?.items[addr.group] : undefined
  const drawers = drawersOf(profile)
  const heading = group ? `${section?.title} / ${group.label}` : (section?.title ?? '')
  const where = drawers.length > 1 ? `${drawers[addr.drawer ?? 0]?.name} › ${heading}` : heading
  const step = r.step && stepsOf(profile, item).some((s) => s.label === r.step) ? r.step : undefined
  return { icon: <EntryIcon type={item.type} icon={item.icon} size={15} />, label: step ? `${item.label} › ${step}` : item.label, where }
}

/** A tool of the right rail, for the drawer the nav shows: its folder's files, its repository, what claude loads there, its settings. */
function RailView({ tool, pane }: { tool: RailTool; pane: Props }) {
  const { active, drawer } = pane
  const profile = active.profile!
  const d = drawersOf(profile)[drawer]
  if (!d) return null
  const folder = d.folder ?? null
  if (tool === 'files') {
    if (!folder) return <RailEmpty name={d.name} />
    return <Browser key={`${active.id}:${folder}`} top={folder} kicker={d.name} heading="Files" pane={pane} />
  }
  if (tool === 'git') {
    if (!folder) return <RailEmpty name={d.name} />
    return (
      <div className="page wide">
        <div className="page-kicker">{d.name}</div>
        <h1 className="page-title">Git</h1>
        <Suspense fallback={null}>
          <GitView key={`${active.id}|${folder}`} profileId={active.id} path={folder} toast={pane.toast} onChanged={pane.actions.gitChanged} />
        </Suspense>
      </div>
    )
  }
  if (tool === 'settings') {
    return (
      <div className="page">
        <div className="page-kicker">{d.name}</div>
        <h1 className="page-title">Drawer settings</h1>
        <Suspense fallback={null}>
          <DrawerDialog key={`${active.id}:${drawer}:${active.rev}`} inline profile={profile} profileId={active.id} index={drawer} run={pane.actions.run} onShow={pane.onDrawerShow} onDeleted={pane.onDrawerDeleted} onClose={() => {}} />
        </Suspense>
      </div>
    )
  }
  return (
    <div className="page wide">
      <div className="page-kicker">{d.name}</div>
      <h1 className="page-title">{RAIL_LABEL[tool]}</h1>
      <Suspense fallback={null}>
        <ClaudeSetupView
          key={`${active.id}:${drawer}:${tool}`}
          profileId={active.id}
          profile={profile}
          folder={folder ?? undefined}
          drawer={drawer}
          kinds={tool === 'mcp' ? ['mcp'] : ['skills', 'agents', 'commands', 'hooks', 'plugins']}
          rev={active.rev}
          toast={pane.toast}
          pins={tool === 'skills' ? { scope: 'drawer', label: d.name, set: (names) => void pane.actions.run([{ op: 'setSkills', drawer, names }], `Skills pinned on ${d.name} changed`) } : undefined}
        />
      </Suspense>
    </div>
  )
}

function RailEmpty({ name }: { name: string }) {
  return (
    <div className="empty-state">
      <h2 style={{ color: 'var(--text)' }}>{name} has no folder yet</h2>
      <p>Give the drawer a folder in its settings (the sliders on the rail) and its files and repository show here.</p>
    </div>
  )
}

/** A folder opened by path (outside a project's tabs): the file browser at `top`. */
function Browser({ top, kicker, heading, pane }: { top: string; kicker: string; heading: React.ReactNode; pane: Props }) {
  const profile = pane.active.profile!
  return (
    <div className="page wide files-page">
      <div className="page-kicker">{kicker}</div>
      <h1 className="page-title">{heading}</h1>
      <FileBrowser top={top} roots={folderRoots(profile)} home={pane.home} onNavigate={pane.openFolder} toast={pane.toast} />
    </div>
  )
}

/** A note opened by path: from a link or a search result, not from the nav. */
function PathNote({ path }: { path: string }) {
  const notes = useNotes()
  const rel = notes.list.find((n) => n.path === path)?.rel
  const folder = rel?.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null
  const name = noteName(path)
  return (
    <NoteView
      path={path}
      title={name}
      kicker={folder ? `Notes · ${folder}` : 'Notes'}
      heading={
        <>
          <FileText size={22} className="icon" />
          {name}
        </>
      }
      below={
        <div className="path-row">
          <span className="path mono">{path}</span>
        </div>
      }
    />
  )
}

function EntryView({ addr, item, kicker, pane }: { addr: ItemAddr; item: NavItem; kicker: string; pane: Props }) {
  const { openExternally } = pane
  if (item.type === 'folder' && !item.page) {
    // A folder link (no page): the file browser; the wiki's context/ opens the Context view.
    const profile = pane.active.profile!
    const want = item.path ? normalizePath(expandHome(item.path, pane.home)) : ''
    const isContext = !!profile.notes && want === normalizePath(expandHome(`${profile.notes}/context`, pane.home))
    if (isContext) return <ContextView key={`${pane.active.id}:context`} name="context" profileId={pane.active.id} profile={profile} home={pane.home} openFolder={pane.openFolder} toast={pane.toast} />
    return (
      <Browser
        key={`${pane.active.id}:${item.path}`}
        top={item.path ?? '~'}
        kicker={kicker}
        heading={
          <>
            <EntryIcon type="folder" icon={item.icon} size={22} />
            {item.label}
          </>
        }
        pane={pane}
      />
    )
  }
  if (item.type === 'note') {
    return (
      <NoteView
        key={item.path}
        path={item.path}
        title={item.label}
        kicker={`${kicker} · ${TYPE_LABEL.note}`}
        heading={
          <>
            <EntryIcon type="note" icon={item.icon} size={22} />
            {item.label}
          </>
        }
        below={
          <div className="path-row">
            <span className="path mono">{item.path}</span>
            <button className="btn ghost" onClick={() => openExternally(addr, item)}>
              <ExternalLink size={14} />
              Open in default app
            </button>
          </div>
        }
      />
    )
  }

  if (item.type === 'daily') return <DailyView item={item} kicker={kicker} />

  if (item.type === 'chat') return <ChatEntry addr={addr} item={item} kicker={kicker} />

  if (item.type === 'folder') {
    return (
      <ProjectView
        key={projectRef(item)}
        addr={addr}
        item={item}
        kicker={kicker}
        profile={pane.active.profile!}
        profileId={pane.active.id}
        home={pane.home}
        actions={pane.actions}
        openFolder={pane.openFolder}
        toast={pane.toast}
      />
    )
  }

  // Groups, links and launchers never open in the centre.
  return null
}

/** A chat entry: its one chat, started the first time it is opened. */
function ChatEntry({ addr, item, kicker }: { addr: ItemAddr; item: Extract<NavItem, { type: 'chat' }>; kicker: string }) {
  const chats = useChats()
  const chat = chats.list.find((c) => c.slot === entrySlot(item)) ?? null
  return (
    <ChatPage
      chat={chat}
      kicker={`${kicker} · ${TYPE_LABEL.chat}`}
      title={
        <>
          <EntryIcon type="chat" agent={chatProgram(item.agent)} icon={item.icon} size={22} />
          {item.label}
        </>
      }
      start={(resume) => chats.start({ at: addr, resume })}
      historyPath={item.path ?? '~'}
    />
  )
}
