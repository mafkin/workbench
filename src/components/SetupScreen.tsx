// Setup (part 13): shown instead of the app while the service has no Workbench
// folder. One folder holds everything Workbench keeps: settings, every profile's
// pages, drawers and their files, templates, skills, context, logos and
// backgrounds. The service makes it with a first profile and one drawer.
import { FolderPlus } from 'lucide-react'
import { useState } from 'react'
import type { AppState } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'

interface Props {
  suggested: string
  onDone: (state: AppState) => void
}

export function SetupScreen({ suggested, onDone }: Props) {
  const [dir, setDir] = useState(suggested)
  const [name, setName] = useState('Main')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!dir.trim()) return setError('Pick a folder')
    if (!name.trim()) return setError('Name the first profile')
    setBusy(true)
    try {
      onDone(await api.setup(dir.trim(), name.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const id = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

  return (
    <div className="setup-screen">
      <form className="dialog setup-form" onSubmit={submit} aria-label="Set up Workbench">
        <header>
          Set up Workbench
          <small>Pick the folder it works in</small>
        </header>
        <div className="body">
          <p className="setup-intro">
            Everything Workbench keeps lives in one folder: its settings, each profile’s pages, drawers and their files, notes, templates, skills and context. You can put the folder in git or sync it; running chats and caches stay in your
            home’s state and cache folders.
          </p>
          <label className="field">
            <span>Folder</span>
            <input className="mono" name="dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/Workbench" autoFocus />
            <span className="hint">Made if it does not exist. A folder that already is a Workbench (it has a settings.yaml) is used as it is.</span>
          </label>
          <label className="field">
            <span>First profile</span>
            <input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Main" />
            <span className="hint">
              Its pages go in <span className="mono">{id || 'main'}/</span> with one drawer of the same name, ready for your first pages. More profiles and drawers come later, from the app.
            </span>
          </label>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button type="submit" className="btn primary" disabled={busy}>
            <FolderPlus size={14} /> Create workbench
          </button>
        </footer>
      </form>
    </div>
  )
}
