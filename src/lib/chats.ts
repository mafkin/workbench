// The chats of the active profile, shared by the nav, project pages and chat
// pages. The service keeps the programs; this is the list and what can be done
// with a chat. Helpers for dropping paths onto a chat live here too.
import { createContext, useContext } from 'react'
import type { Chat, ClaudeSession } from '../../shared/config-schema.ts'
import type { ChatStart } from './api.ts'
import { readLocal, writeLocal } from './local.ts'

export interface ChatsApi {
  profile: string
  list: Chat[]
  /** The list has been fetched for this profile. */
  loaded: boolean
  /** Start a chat (or get a step's or entry's chat); errors are shown, and null returned. */
  start: (req: ChatStart) => Promise<Chat | null>
  restart: (chat: Chat, fresh: boolean) => Promise<void>
  update: (chat: Chat, patch: { label?: string | null; color?: string | null; pinned?: boolean }) => Promise<void>
  /** Summarize and continue in a new chat. */
  handoff: (chat: Chat) => Promise<Chat | null>
  /** Close a chat; a running one asks first. */
  close: (chat: Chat) => void
  history: (path: string) => Promise<ClaudeSession[]>
  /** Show a chat: its tab in its project, its entry, or a page of its own. */
  open: (chat: Chat) => void
}

export const ChatsCtx = createContext<ChatsApi | null>(null)

export function useChats(): ChatsApi {
  const c = useContext(ChatsCtx)
  if (!c) throw new Error('useChats outside ChatsCtx')
  return c
}

/** A project's open tab: '' for All files, a step label, or `chat:<id>`. */
export const CHAT_TAB = 'chat:'
const TAB_EVENT = 'workbench:project-tab'

/**
 * Pick a project's tab from outside its page. The page reads the tab from
 * storage when it mounts and listens for this while it is open.
 */
export function showProjectTab(profile: string, projectPath: string, tab: string) {
  const key = `${profile}|${projectPath}`
  writeLocal('projectTab', { ...readLocal<Record<string, string>>('projectTab', {}), [key]: tab })
  window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: { key, tab } }))
}

export function onProjectTab(fn: (key: string, tab: string) => void): () => void {
  const listener = (e: Event) => {
    const { key, tab } = (e as CustomEvent<{ key: string; tab: string }>).detail
    fn(key, tab)
  }
  window.addEventListener(TAB_EVENT, listener)
  return () => window.removeEventListener(TAB_EVENT, listener)
}

/** The step label in a step's slot key (`step:<project>|<label>`). */
export const slotStep = (slot: string) => slot.slice(slot.indexOf('|') + 1)

/** Pinned first, then in the order they were started. */
export const byPin = (a: Chat, b: Chat) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt

// Text for a chat's prompt (dropped paths) goes to its open terminal, or waits
// here until a terminal for it has connected.
const pending = new Map<string, string>()
const terminals = new Map<string, (text: string) => void>()

export function pasteInto(id: string, text: string) {
  const paste = terminals.get(id)
  if (paste) paste(text)
  else pending.set(id, (pending.get(id) ?? '') + text)
}

/** A connected terminal takes what waited for it, then gets pastes directly. */
export function registerTerminal(id: string, paste: (text: string) => void): () => void {
  terminals.set(id, paste)
  const waiting = pending.get(id)
  pending.delete(id)
  if (waiting) paste(waiting)
  return () => {
    if (terminals.get(id) === paste) terminals.delete(id)
  }
}

/** Drags from the file browser and step tabs carry absolute paths under this type. */
export const PATHS_TYPE = 'application/x-workbench-paths'

export const carriesPaths = (e: React.DragEvent) => e.dataTransfer.types.includes(PATHS_TYPE)

export function droppedPaths(e: React.DragEvent): string[] {
  try {
    const paths = JSON.parse(e.dataTransfer.getData(PATHS_TYPE))
    return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []
  } catch {
    return []
  }
}

/** Paths as typed into a prompt: plain ones as they are, others in single quotes; a space after. */
export function quotePaths(paths: string[]): string {
  const quote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)
  return paths.length ? `${paths.map(quote).join(' ')} ` : ''
}
