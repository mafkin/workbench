import { createContext, useContext } from 'react'
import type { NoteSummary } from '../../shared/config-schema.ts'

/** What note views need from the app; provided by App for the active profile. */
export interface NotesApi {
  profile: string
  /** The profile's folder (part 13): where new notes, daily notes, search and wiki links live. */
  root: string
  /** Every note the profile can reach, newest first; resolves wiki links. */
  list: NoteSummary[]
  /** The profile's projects, for `[[Project/path]]` links to files in them. */
  projects: { label: string; path: string }[]
  open: (path: string) => void
  /** A folder (or a file's folder) in the file browser, for links to files that are not notes. */
  openFolder: (path: string) => void
  /** Clicked a [[wiki link]] to a note that does not exist yet: offers to create it. */
  missing: (name: string) => void
  /** Create the note `name` (a `[[link]]` target, folders allowed) from the page template and open it. */
  create: (name: string) => Promise<void>
  /** Open the search box with this query (`#tag` finds notes carrying the tag). */
  search: (query: string) => void
  /** A note was created or saved; refreshes the list. */
  changed: () => void
  notify: (message: string, kind?: 'info' | 'error') => void
  /** A note just created, which opens in Edit once. */
  fresh: string | null
  clearFresh: () => void
}

export const NotesCtx = createContext<NotesApi>(null!)
export const useNotes = () => useContext(NotesCtx)
