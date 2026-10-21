import type { ItemAddr, ItemType, ListAddr, NavItem } from '../../shared/config-schema.ts'

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
