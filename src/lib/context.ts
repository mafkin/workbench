// The active profile's context folders, for the nav heading, the context pages
// and the file browser's "Send to inbox". App keeps the status fresh (SSE).
import { createContext, useContext } from 'react'
import type { ContextFolder, ContextStatus } from '../../shared/config-schema.ts'

export interface ContextApi {
  status: ContextStatus | null
  /** Make the folders and starter notes (and set `notes:` first if the profile has none). */
  setup: () => void
  open: (name: ContextFolder) => void
  /** Copy a file into the inbox. */
  sendToInbox: (path: string) => void
}

export const ContextCtx = createContext<ContextApi | null>(null)

export const useContextFolders = () => useContext(ContextCtx)
