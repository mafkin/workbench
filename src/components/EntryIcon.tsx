import { FileText, Folder, FolderTree, LayoutGrid, Link2, Play, type LucideIcon } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic.mjs'
import type { ItemType } from '../../shared/config-schema.ts'

export const TYPE_ICON: Record<ItemType, LucideIcon> = {
  folder: Folder,
  note: FileText,
  project: LayoutGrid,
  link: Link2,
  launch: Play,
  group: FolderTree,
}

export const TYPE_LABEL: Record<ItemType, string> = {
  folder: 'Folder',
  note: 'Note',
  project: 'Project',
  link: 'Link',
  launch: 'Launcher',
  group: 'Group',
}

const known = new Set<string>(iconNames)
export const isIconName = (name: string) => known.has(name)

/** The entry's own lucide icon when it names one, otherwise its type's icon. */
export function EntryIcon({ type, icon, size = 15 }: { type: ItemType; icon?: string; size?: number }) {
  const Fallback = TYPE_ICON[type]
  if (icon && known.has(icon)) {
    return (
      <DynamicIcon
        name={icon as IconName}
        size={size}
        className="icon"
        fallback={() => <Fallback size={size} className="icon" />}
      />
    )
  }
  return <Fallback size={size} className="icon" />
}
