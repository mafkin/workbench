import { CalendarDays, File, FileChartColumn, FileText, Folder, FolderTree, Link2, Play, type LucideIcon } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic.mjs'
import type { AnyType } from '../../shared/config-schema.ts'

// Nav entry types, and the step-only report and file.
export const TYPE_ICON: Record<AnyType, LucideIcon> = {
  folder: Folder,
  note: FileText,
  report: FileChartColumn,
  file: File,
  daily: CalendarDays,
  link: Link2,
  launch: Play,
  group: FolderTree,
}

export const TYPE_LABEL: Record<AnyType, string> = {
  folder: 'Folder',
  note: 'Note',
  report: 'Report',
  file: 'File',
  daily: 'Daily',
  link: 'Link',
  launch: 'Launcher',
  group: 'Group',
}

const known = new Set<string>(iconNames)
export const isIconName = (name: string) => known.has(name)

/** The entry's own lucide icon when it names one, otherwise its type's icon. */
export function EntryIcon({ type, icon, size = 15 }: { type: AnyType; icon?: string; size?: number }) {
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
