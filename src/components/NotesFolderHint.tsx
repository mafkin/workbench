import { FolderPlus } from 'lucide-react'
import { useNotes } from '../lib/notes-ctx.ts'

/** Shown where a notes folder is needed but the profile has none. */
export function NotesFolderHint({ compact = false }: { compact?: boolean }) {
  const { profile, suggestedRoot, setRoot } = useNotes()
  return (
    <div className={compact ? 'notes-hint compact' : 'placeholder notes-hint'}>
      {!compact && <h3>No notes folder yet</h3>}
      <p>
        New notes, daily notes, search and wiki links use the folder set by <span className="mono">notes:</span> in{' '}
        <span className="mono">{profile}.yaml</span>.
      </p>
      <button type="button" className="btn primary" onClick={() => setRoot(suggestedRoot)}>
        <FolderPlus size={14} /> Use {suggestedRoot}
      </button>
    </div>
  )
}
