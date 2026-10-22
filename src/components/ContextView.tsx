// A context folder's page. Context itself has tabs for its notes (identity,
// preferences, goals and the routing note, editable in place) beside All files;
// knowledge, processes and the inbox are their folder in the file browser.
import { BookOpen, FolderOpen, FolderPlus, IdCard, Inbox, Workflow, type LucideIcon } from 'lucide-react'
import { CONTEXT_LABEL, folderRoots, type ContextFolder, type Profile } from '../../shared/config-schema.ts'
import { useContextFolders } from '../lib/context.ts'
import { useLocal } from '../lib/local.ts'
import { cx } from '../lib/nav.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { NoteView } from './NoteView.tsx'
import type { ToastInput } from './Toast.tsx'

const ICON: Record<ContextFolder, LucideIcon> = { context: IdCard, knowledge: BookOpen, processes: Workflow, inbox: Inbox }

const ABOUT: Record<ContextFolder, string> = {
  context: 'Who you are, how you like things done and what you’re aiming for. Every claude chat starts with these notes and the routing note.',
  knowledge: 'Reusable facts and how-tos, one topic per note. Chats can read them and add to them.',
  processes: 'Workflows you repeat. Chats can read them and add to them.',
  inbox: 'Handoffs from Summarize and continue, and files you send to the inbox from the file browser.',
}

/** Context's note tabs: file name and tab label. */
const NOTES: [string, string][] = [
  ['identity.md', 'Identity'],
  ['preferences.md', 'Preferences'],
  ['goals.md', 'Goals'],
  ['README.md', 'Where things go'],
]

interface Props {
  name: ContextFolder
  profileId: string
  profile: Profile
  home: string
  openFolder: (path: string) => void
  toast: (t: ToastInput) => void
}

export function ContextView({ name, profileId, profile, home, openFolder, toast }: Props) {
  const ctx = useContextFolders()
  const folder = ctx?.status?.folders.find((f) => f.name === name)
  const [tabs, setTabs] = useLocal<Record<string, string>>('contextTab', {})
  const tab = tabs[profileId] ?? ''
  const Icon = ICON[name]

  return (
    <div className="page wide context-page">
      <div className="page-kicker">Context</div>
      <h1 className="page-title">
        <Icon size={22} className="icon" />
        {CONTEXT_LABEL[name]}
      </h1>
      <p className="page-sub">{ABOUT[name]}</p>
      {folder && (
        <div className="path-row">
          <span className="path mono">{folder.path}</span>
        </div>
      )}
      {!folder ? null : !folder.exists ? (
        <div className="placeholder">
          <h3>This folder does not exist</h3>
          <p className="mono">{folder.path}</p>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={() => ctx?.setup()}>
            <FolderPlus size={14} /> Create folder
          </button>
        </div>
      ) : name === 'context' ? (
        <>
          <div className="step-tabs" role="tablist" aria-label="Context notes">
            <button role="tab" aria-selected={!tab} className={cx('step-tab', !tab && 'active')} onClick={() => setTabs((t) => ({ ...t, [profileId]: '' }))}>
              <FolderOpen size={14} className="icon" />
              All files
            </button>
            {NOTES.map(([file, label]) => (
              <button key={file} role="tab" aria-selected={tab === file} className={cx('step-tab', tab === file && 'active')} onClick={() => setTabs((t) => ({ ...t, [profileId]: file }))}>
                {label}
              </button>
            ))}
          </div>
          {tab ? (
            <NoteView
              key={`${folder.path}/${tab}`}
              path={`${folder.path}/${tab}`}
              title={NOTES.find(([f]) => f === tab)?.[1] ?? tab}
              // The note has its own title; the small heading says which file it is.
              heading={<span className="mono">{`${folder.path}/${tab}`}</span>}
              compact
            />
          ) : (
            <FileBrowser key={folder.path} top={folder.path} roots={folderRoots(profile)} home={home} onNavigate={openFolder} toast={toast} />
          )}
        </>
      ) : (
        <FileBrowser key={folder.path} top={folder.path} roots={folderRoots(profile)} home={home} onNavigate={openFolder} toast={toast} />
      )}
    </div>
  )
}
