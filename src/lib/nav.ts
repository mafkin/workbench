import { getItem, type ContextFolder, type ItemAddr, type ItemType, type ListAddr, type NavItem, type Profile, type StepItem } from '../../shared/config-schema.ts'

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

export function parseKey(key: string | undefined): ItemAddr | null {
  if (!key) return null
  const parts = key.split('.').map(Number)
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null
  if (parts.length === 2) return { section: parts[0], index: parts[1] }
  if (parts.length === 3) return { section: parts[0], group: parts[1], index: parts[2] }
  return null
}

export const sameList = (a: ListAddr, b: ListAddr) => a.section === b.section && a.group === b.group

/** What an entry does when clicked outside edit mode. */
export const opensExternally = (item: NavItem) => item.type === 'link' || item.type === 'launch'

export function describeTarget(item: NavItem): string {
  switch (item.type) {
    case 'folder':
    case 'note':
      return item.path
    case 'daily':
      return `${item.folder ?? 'daily'}/YYYY-MM-DD.md in the notes folder`
    case 'chat':
      return `${item.agent === 'shell' ? 'Shell' : 'Claude'} in ${item.path ?? '~'}`
    case 'link':
      return item.url
    case 'launch':
      return [item.command, ...item.args].join(' ')
    case 'group':
      return `${item.items.length} entries`
  }
}

export type DialogState =
  | { mode: 'add'; list: ListAddr; index?: number; context: string; presetType?: ItemType }
  | { mode: 'edit'; at: ItemAddr; item: NavItem; context: string }
  | { mode: 'note'; list: ListAddr; context: string }
  /** Add a workflow step to the project at `at`, or edit step `index`; `base` is the project folder. */
  | { mode: 'step'; at: ItemAddr; index?: number; item?: StepItem; context: string; base: string }

/**
 * What the main pane shows: a nav entry, a note opened by path (a link or a
 * search result), a folder opened by path (a chip, the path bar, a subfolder),
 * a chat whose project or entry is gone, the Claude setup page, or a context folder.
 */
export type Selection =
  | { kind: 'entry'; addr: ItemAddr; item: NavItem }
  | { kind: 'note'; path: string }
  | { kind: 'files'; path: string }
  | { kind: 'chat'; id: string }
  | { kind: 'setup' }
  | { kind: 'servers' }
  | { kind: 'context'; name: ContextFolder }

/** Selection key prefixes for a note, folder or chat opened on its own; other keys are entry addresses. */
export const NOTE_KEY = 'note:'
export const FILES_KEY = 'files:'
export const CHAT_KEY = 'chat:'
/** The Claude setup page. */
export const SETUP_KEY = 'setup:'
/** The Servers page. */
export const SERVERS_KEY = 'servers:'
/** A context folder's page: `context:inbox`. */
export const CONTEXT_KEY = 'context:'

/** What identifies an entry besides its address: its type, label and path. */
export function entryId(item: NavItem): string {
  return `${item.type}|${item.label}|${'path' in item ? (item.path ?? '') : ''}`
}

/** Every entry with its address, groups' children included. */
function allEntries(profile: Profile): { addr: ItemAddr; item: NavItem }[] {
  const out: { addr: ItemAddr; item: NavItem }[] = []
  for (const [si, section] of profile.sections.entries()) {
    for (const [i, item] of section.items.entries()) {
      out.push({ addr: { section: si, index: i }, item })
      if (item.type === 'group') for (const [ci, child] of item.items.entries()) out.push({ addr: { section: si, group: i, index: ci }, item: child })
    }
  }
  return out
}

/**
 * Where the entry saved as `key` (an address) and `id` (entryId) is now: still
 * there, moved (the same id elsewhere), or renamed (the same type and path).
 * Null when it is gone. Without an id, the address is trusted.
 */
export function resolveEntry(profile: Profile, key: string, id?: string): ItemAddr | null {
  const addr = parseKey(key)
  const item = addr ? getItem(profile, addr) : undefined
  if (!id) return addr && item ? addr : null
  if (addr && item && entryId(item) === id) return addr
  const all = allEntries(profile)
  const same = all.find((e) => entryId(e.item) === id)
  if (same) return same.addr
  const [type, , path] = id.split('|')
  const renamed = path ? all.find((e) => e.item.type === type && 'path' in e.item && e.item.path === path) : undefined
  return renamed?.addr ?? null
}

/** The first entry of a type that matches, searching headings and groups. */
export function findEntry(profile: Profile, type: ItemType, matches: (item: NavItem) => boolean = () => true): ItemAddr | null {
  for (const [si, section] of profile.sections.entries()) {
    for (const [i, item] of section.items.entries()) {
      if (item.type === type && matches(item)) return { section: si, index: i }
      if (item.type !== 'group') continue
      for (const [ci, child] of item.items.entries()) {
        if (child.type === type && matches(child)) return { section: si, group: i, index: ci }
      }
    }
  }
  return null
}

export function listLength(profile: Profile, list: ListAddr): number {
  const items = profile.sections[list.section]?.items ?? []
  if (list.group === undefined) return items.length
  const group = items[list.group]
  return group?.type === 'group' ? group.items.length : 0
}

export interface MenuEntry {
  label: string
  icon?: React.ReactNode
  /** Muted text after the label, e.g. when. */
  detail?: string
  danger?: boolean
  disabled?: boolean
  run: () => void
}

export interface MenuState {
  x: number
  y: number
  entries: (MenuEntry | 'sep')[]
}

export type DragData =
  | { kind: 'section'; section: number; title: string }
  | { kind: 'item'; addr: ItemAddr; item: NavItem }

export type DropData =
  | DragData
  | { kind: 'list'; list: ListAddr; length: number }
