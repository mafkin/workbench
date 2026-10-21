import { ArrowLeft, ExternalLink, FileText, FolderOpen, Pencil, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NOTE_EXT, type ItemAddr, type NavItem, type ProfileState, type SearchHit } from '../../shared/config-schema.ts'
import { stat } from '../lib/api.ts'
import { opensExternally, type Selection } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { DailyView } from './DailyView.tsx'
import { EntryIcon, TYPE_LABEL } from './EntryIcon.tsx'
import { NotesFolderHint } from './NotesFolderHint.tsx'
import { NoteView } from './NoteView.tsx'
import { SearchView } from './SearchView.tsx'

export interface SearchState {
  open: boolean
  query: string
}

interface Props {
  active: ProfileState
  selected: Selection | null
  search: SearchState
  setSearch: (s: SearchState) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  canGoBack: boolean
  onBack: () => void
  onHome: () => void
  activate: (addr: ItemAddr, item: NavItem) => void
  openExternally: (addr: ItemAddr, item: NavItem) => void
  startEditing: () => void
}

const noteName = (path: string) => (path.split('/').pop() ?? path).replace(NOTE_EXT, '')

export function MainPane({ active, selected, search, setSearch, searchRef, canGoBack, onBack, onHome, activate, openExternally, startEditing }: Props) {
  const notes = useNotes()
  const firstHit = useRef<string | null>(null)
  const profile = active.profile
  const entry = selected?.kind === 'entry' ? selected : null
  const section = entry && profile ? profile.sections[entry.addr.section] : undefined
  const group = entry && section && entry.addr.group !== undefined ? section.items[entry.addr.group] : undefined
  const atHome = !selected && !search.open

  return (
    <main className="main">
      <div className="topbar">
        {canGoBack && (
          <button className="icon-btn" onClick={onBack} title="Back (Alt+←)" aria-label="Back">
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="crumbs">
          {atHome ? <span className="current">{profile?.name ?? active.id}</span> : <button onClick={onHome}>{profile?.name ?? active.id}</button>}
          {search.open ? (
            <>
              <span className="sep">/</span>
              <span className="current">Search</span>
            </>
          ) : entry ? (
            <>
              {section && (
                <>
                  <span className="sep">/</span>
                  <span>{section.title}</span>
                </>
              )}
              {group && (
                <>
                  <span className="sep">/</span>
                  <span>{group.label}</span>
                </>
              )}
              <span className="sep">/</span>
              <span className="current">{entry.item.label}</span>
            </>
          ) : selected?.kind === 'note' ? (
            <>
              <span className="sep">/</span>
              <span>Notes</span>
              <span className="sep">/</span>
              <span className="current" title={selected.path}>
                {noteName(selected.path)}
              </span>
            </>
          ) : null}
        </div>
        <span style={{ flex: 1 }} />
        <label className="search-box">
          <Search size={13} />
          <input
            ref={searchRef}
            value={search.query}
            placeholder="Search notes"
            aria-label="Search notes"
            onFocus={() => !search.open && setSearch({ ...search, open: true })}
            onChange={(e) => setSearch({ open: true, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setSearch({ ...search, open: false })
                e.currentTarget.blur()
              } else if (e.key === 'Enter' && firstHit.current) {
                notes.open(firstHit.current)
                e.currentTarget.blur()
              }
            }}
          />
          {!search.open && <span className="kbd">Ctrl+Shift+F</span>}
        </label>
      </div>
      <div className="content">
        {!profile ? (
          <BrokenProfile active={active} />
        ) : search.open ? (
          <SearchView query={search.query} onResults={(hits: SearchHit[]) => (firstHit.current = hits[0]?.path ?? null)} />
        ) : entry ? (
          <EntryView key={`${active.id}:${entry.item.label}`} addr={entry.addr} item={entry.item} kicker={section?.title ?? ''} openExternally={openExternally} />
        ) : selected?.kind === 'note' ? (
          <PathNote key={selected.path} path={selected.path} />
        ) : (
          <Home active={active} activate={activate} startEditing={startEditing} />
        )}
      </div>
    </main>
  )
}

function BrokenProfile({ active }: { active: ProfileState }) {
  return (
    <div className="empty-state">
      <h2 style={{ color: 'var(--text)' }}>{active.id}.yaml cannot be read</h2>
      <p>
        {active.error?.line ? `Line ${active.error.line}: ` : ''}
        {active.error?.message}
      </p>
      <p>Fix the file and Workbench reloads it automatically.</p>
    </div>
  )
}

function Home({ active, activate, startEditing }: { active: ProfileState; activate: Props['activate']; startEditing: () => void }) {
  const profile = active.profile!
  const count = profile.sections.reduce((n, s) => n + s.items.reduce((m, i) => m + (i.type === 'group' ? i.items.length : 1), 0), 0)

  if (profile.sections.length === 0) {
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

  const entry = (addr: ItemAddr, item: NavItem, indent = false) => (
    <li key={`${addr.group ?? ''}.${addr.index}`}>
      <button onClick={() => activate(addr, item)} style={indent ? { paddingLeft: 22 } : undefined} title={item.label}>
        <EntryIcon type={item.type} icon={item.icon} size={14} />
        <span className="label">{item.label}</span>
        {opensExternally(item) && <ExternalLink size={11} style={{ color: 'var(--faint)', flex: 'none' }} />}
      </button>
    </li>
  )

  return (
    <div className="page">
      <div className="page-kicker">Profile</div>
      <h1 className="page-title">{profile.name}</h1>
      <p className="page-sub">
        {profile.sections.length} headings · {count} entries
        {profile.home && (
          <>
            {' · home '}
            <span className="mono">{profile.home}</span>
          </>
        )}
        {profile.notes && (
          <>
            {' · notes '}
            <span className="mono">{profile.notes}</span>
          </>
        )}
      </p>
      {!profile.notes && <NotesFolderHint compact />}
      <div className="overview">
        {profile.sections.map((s, si) => (
          <section className="card" key={si}>
            <h2>
              {s.title} <span>{s.items.length}</span>
            </h2>
            {s.items.length === 0 ? (
              <div className="none">Nothing here yet</div>
            ) : (
              <ul>
                {s.items.flatMap((item, i) =>
                  item.type === 'group'
                    ? [
                        <li key={`g${i}`}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: '0 6px', color: 'var(--muted)' }}>
                            <EntryIcon type="group" icon={item.icon} size={14} />
                            {item.label}
                          </div>
                        </li>,
                        ...item.items.map((child, ci) => entry({ section: si, group: i, index: ci }, child, true)),
                      ]
                    : [entry({ section: si, index: i }, item)],
                )}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}

function PathStatus({ path, want }: { path: string; want: 'dir' | 'file' }) {
  const [status, setStatus] = useState<{ exists: boolean; kind: string | null } | null>(null)
  useEffect(() => {
    let live = true
    stat(path).then((s) => live && setStatus(s), () => live && setStatus(null))
    return () => {
      live = false
    }
  }, [path])
  if (!status) return null
  if (!status.exists) return <span className="status bad">Not found</span>
  if (status.kind !== want) return <span className="status bad">{want === 'dir' ? 'Not a folder' : 'Not a file'}</span>
  return <span className="status ok">Found</span>
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

function EntryView({ addr, item, kicker, openExternally }: { addr: ItemAddr; item: NavItem; kicker: string; openExternally: Props['openExternally'] }) {
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

  return (
    <div className="page">
      <div className="page-kicker">
        {kicker} · {TYPE_LABEL[item.type]}
      </div>
      <h1 className="page-title">
        <EntryIcon type={item.type} icon={item.icon} size={22} />
        {item.label}
      </h1>

      {item.type === 'folder' && (
        <>
          <div className="path-row">
            <span className="path mono">{item.path}</span>
            <PathStatus path={item.path} want="dir" />
            <button className="btn" onClick={() => openExternally(addr, item)}>
              <FolderOpen size={14} />
              Open in Files
            </button>
          </div>
          <div className="placeholder">
            <h3>File browser: part 3</h3>
            <p>The folder tree, quick-jump chips, filter and previews will open here.</p>
          </div>
        </>
      )}

      {item.type === 'project' && (
        <>
          <div className="path-row">
            <span className="path mono">project: {item.project}</span>
          </div>
          <div className="placeholder">
            <h3>Project cards: part 4</h3>
            <p>The card for this project, with its tabs for brief, plan, reports and assets, will open here.</p>
          </div>
        </>
      )}
    </div>
  )
}
