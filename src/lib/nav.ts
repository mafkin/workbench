import type { ItemAddr, ItemType, ListAddr, NavItem, Profile } from '../../shared/config-schema.ts'

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
    case 'link':
      return item.url
    case 'launch':
      return [item.command, ...item.args].join(' ')
    case 'project':
      return `project: ${item.project}`
    case 'group':
      return `${item.items.length} entries`
  }
}

export type DialogState =
  | { mode: 'add'; list: ListAddr; index?: number; context: string; presetType?: ItemType }
  | { mode: 'edit'; at: ItemAddr; item: NavItem; context: string }
  | { mode: 'note'; list: ListAddr; context: string }

/**
 * What the main pane shows: a nav entry, a note opened by path (a link or a
 * search result), or a folder opened by path (a chip, the path bar, a subfolder).
 */
export type Selection =
  | { kind: 'entry'; addr: ItemAddr; item: NavItem }
  | { kind: 'note'; path: string }
  | { kind: 'files'; path: string }

/** Selection key prefixes for a note or folder opened by path; other keys are entry addresses. */
export const NOTE_KEY = 'note:'
export const FILES_KEY = 'files:'

/** The first note or folder entry whose path matches, searching headings and groups. */
export function findEntry(profile: Profile, type: 'note' | 'folder', matches: (path: string) => boolean): ItemAddr | null {
  for (const [si, section] of profile.sections.entries()) {
    for (const [i, item] of section.items.entries()) {
      if (item.type === type && matches(item.path)) return { section: si, index: i }
      if (item.type !== 'group') continue
      for (const [ci, child] of item.items.entries()) {
        if (child.type === type && matches(child.path)) return { section: si, group: i, index: ci }
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
  danger?: boolean
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
