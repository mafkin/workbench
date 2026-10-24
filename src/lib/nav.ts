import { getItem, sectionsOf, walkItems, type ContextFolder, type ItemAddr, type ItemType, type ListAddr, type NavItem, type Profile, type SharedItem, type StepItem } from '../../shared/config-schema.ts'

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

/** An address from its key (`itemKey`): `s.i`, `s.g.i`, or either with `d:` in front for a later drawer. */
export function parseKey(key: string | undefined): ItemAddr | null {
  const m = key?.match(/^(?:(\d+):)?(\d+(?:\.\d+){1,2})$/)
  if (!m) return null
  const drawer = m[1] ? Number(m[1]) : 0
  const parts = m[2].split('.').map(Number)
  const at = drawer ? { drawer } : {}
  if (parts.length === 2) return { ...at, section: parts[0], index: parts[1] }
  return { ...at, section: parts[0], group: parts[1], index: parts[2] }
}

export const sameList = (a: ListAddr, b: ListAddr) => (a.drawer ?? 0) === (b.drawer ?? 0) && a.section === b.section && a.group === b.group

/** What an entry does when clicked outside edit mode. */
export const opensExternally = (item: NavItem) => item.type === 'link' || item.type === 'launch'

export function describeTarget(item: NavItem): string {
  switch (item.type) {
    case 'folder':
      return item.path ?? 'An item without a folder'
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
    case 'shared':
      return `From ${item.drawer}`
  }
}

export type DialogState =
  | { mode: 'add'; list: ListAddr; index?: number; context: string; presetType?: ItemType }
  | { mode: 'edit'; at: ItemAddr; item: NavItem; context: string }
  | { mode: 'note'; list: ListAddr; context: string }
  /**
   * Add a step to the item at `at`, or edit step `index`; `base` is the folder its
   * relative paths start from. `seed` is what an older project shows until it has
   * steps of its own; `needsFolder` asks for the item's folder (it has none) when
   * the step shows it. `presetType` picks the kind.
   */
  | { mode: 'step'; at: ItemAddr; index?: number; item?: StepItem; context: string; base: string; seed?: StepItem[]; needsFolder?: boolean; presetType?: StepItem['type'] }

/**
 * What the main pane shows: a nav entry, a note opened by path (a link or a
 * search result), a folder opened by path (a chip, the path bar, a subfolder),
 * a chat whose project or entry is gone, the Claude setup page, or a context folder.
 */
export type Selection =
  /** `addr` is where it is in the nav; `item` and `origin` are the original a shared entry stands for (else the same). */
  | { kind: 'entry'; addr: ItemAddr; item: NavItem; origin: ItemAddr; shared?: SharedItem }
  | { kind: 'note'; path: string }
  | { kind: 'files'; path: string }
  | { kind: 'chat'; id: string }
  /** A tool of the right rail, for the drawer being shown (part 12). */
  | { kind: 'rail'; tool: RailTool }
  | { kind: 'servers' }
  | { kind: 'context'; name: ContextFolder }

/** Selection key prefixes for a note, folder or chat opened on its own; other keys are entry addresses. */
export const NOTE_KEY = 'note:'
export const FILES_KEY = 'files:'
export const CHAT_KEY = 'chat:'
/** A rail tool: `rail:git`. */
export const RAIL_KEY = 'rail:'
export const RAIL_TOOLS = ['files', 'git', 'skills', 'mcp', 'settings'] as const
export type RailTool = (typeof RAIL_TOOLS)[number]
export const RAIL_LABEL: Record<RailTool, string> = { files: 'Files', git: 'Git', skills: 'Skills', mcp: 'MCP servers', settings: 'Drawer settings' }
/** The Servers page. */
export const SERVERS_KEY = 'servers:'
/** A context folder's page: `context:inbox`. */
export const CONTEXT_KEY = 'context:'

/** What identifies an entry besides its address: its type, label and path. */
export function entryId(item: NavItem): string {
  return `${item.type}|${item.label}|${'path' in item ? (item.path ?? '') : ''}`
}

/** Every entry with its address, groups' children included; those of drawer `first` come first. */
function allEntries(profile: Profile, first = 0): { addr: ItemAddr; item: NavItem }[] {
  const all = walkItems(profile)
  return [...all.filter((e) => (e.addr.drawer ?? 0) === first), ...all.filter((e) => (e.addr.drawer ?? 0) !== first)]
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
  // Moved: look in its own drawer first.
  const all = allEntries(profile, addr?.drawer ?? 0)
  const same = all.find((e) => entryId(e.item) === id)
  if (same) return same.addr
  const [type, label, path] = id.split('|')
  const renamed = path ? all.find((e) => e.item.type === type && 'path' in e.item && e.item.path === path) : undefined
  if (renamed) return renamed.addr
  // Still in its place with its name: only its folder changed (an item given one).
  return addr && item && item.type === type && item.label === label ? addr : null
}

/** The first entry of a type that matches, searching headings and groups, drawer `first` before the others. */
export function findEntry(profile: Profile, type: ItemType, matches: (item: NavItem) => boolean = () => true, first = 0): ItemAddr | null {
  return allEntries(profile, first).find((e) => e.item.type === type && matches(e.item))?.addr ?? null
}

export function listLength(profile: Profile, list: ListAddr): number {
  const items = sectionsOf(profile, list.drawer)[list.section]?.items ?? []
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
  /** A choice (`radio`, one of several) or a toggle (`checkbox`); `checked` shows a tick. */
  kind?: 'radio' | 'checkbox'
  checked?: boolean
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
