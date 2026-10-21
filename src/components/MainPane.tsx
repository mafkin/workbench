import { ExternalLink, FolderOpen, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ItemAddr, NavItem, ProfileState } from '../../shared/config-schema.ts'
import { stat } from '../lib/api.ts'
import { opensExternally } from '../lib/nav.ts'
import { EntryIcon, TYPE_LABEL } from './EntryIcon.tsx'

interface Props {
  active: ProfileState
  selected: { addr: ItemAddr; item: NavItem } | null
  onHome: () => void
  activate: (addr: ItemAddr, item: NavItem) => void
  openExternally: (addr: ItemAddr, item: NavItem) => void
  startEditing: () => void
}

export function MainPane({ active, selected, onHome, activate, openExternally, startEditing }: Props) {
  const profile = active.profile
  const section = selected && profile ? profile.sections[selected.addr.section] : undefined
  const group = selected && section && selected.addr.group !== undefined ? section.items[selected.addr.group] : undefined

  return (
    <main className="main">
      <div className="topbar">
        <div className="crumbs">
          {selected ? <button onClick={onHome}>{profile?.name ?? active.id}</button> : <span className="current">{profile?.name ?? active.id}</span>}
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
          {selected && (
            <>
              <span className="sep">/</span>
              <span className="current">{selected.item.label}</span>
            </>
          )}
        </div>
      </div>
      <div className="content">
        {!profile ? (
          <BrokenProfile active={active} />
        ) : selected ? (
          <EntryView key={`${active.id}:${selected.item.label}`} addr={selected.addr} item={selected.item} kicker={section?.title ?? ''} openExternally={openExternally} />
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
      </p>
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

function EntryView({ addr, item, kicker, openExternally }: { addr: ItemAddr; item: NavItem; kicker: string; openExternally: Props['openExternally'] }) {
  return (
    <div className="page">
      <div className="page-kicker">
        {kicker} · {TYPE_LABEL[item.type]}
      </div>
      <h1 className="page-title">
        <EntryIcon type={item.type} icon={item.icon} size={22} />
        {item.label}
      </h1>

      {(item.type === 'folder' || item.type === 'note') && (
        <>
          <div className="path-row">
            <span className="path mono">{item.path}</span>
            <PathStatus path={item.path} want={item.type === 'folder' ? 'dir' : 'file'} />
            <button className="btn" onClick={() => openExternally(addr, item)}>
              {item.type === 'folder' ? <FolderOpen size={14} /> : <ExternalLink size={14} />}
              {item.type === 'folder' ? 'Open in Files' : 'Open in default app'}
            </button>
          </div>
          <div className="placeholder">
            {item.type === 'folder' ? (
              <>
                <h3>File browser: part 3</h3>
                <p>The folder tree, quick-jump chips, filter and previews will open here.</p>
              </>
            ) : (
              <>
                <h3>Notes: part 2</h3>
                <p>This note will open here formatted, with an Edit mode that saves in place.</p>
              </>
            )}
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
