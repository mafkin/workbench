import { createContext, useContext } from 'react'
import type { NoteSummary } from '../../shared/config-schema.ts'

/** What note views need from the app; provided by App for the active profile. */
export interface NotesApi {
  profile: string
  /** The profile's notes folder as written in its config, if set. */
  root?: string
  /** Offered when no notes folder is set: `<home>/notes`. */
  suggestedRoot: string
  /** Write `notes:` into the profile file. */
  setRoot: (value: string) => void
  /** Every note the profile can reach, newest first; resolves wiki links. */
  list: NoteSummary[]
  open: (path: string) => void
  /** Clicked a [[wiki link]] to a note that does not exist yet. */
  missing: (name: string) => void
  /** A note was created or saved; refreshes the list. */
  changed: () => void
  notify: (message: string, kind?: 'info' | 'error') => void
  /** A note just created, which opens in Edit once. */
  fresh: string | null
  clearFresh: () => void
}

export const NotesCtx = createContext<NotesApi>(null!)
export const useNotes = () => useContext(NotesCtx)
