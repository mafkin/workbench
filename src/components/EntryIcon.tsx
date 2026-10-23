import { ArrowLeftRight, Blocks, CalendarDays, File, FileChartColumn, FileText, Folder, FolderOpen, FolderTree, GitBranch, Link2, Play, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic.mjs'
import type { Agent, AnyType } from '../../shared/config-schema.ts'

// Nav entry types, and the step-only kinds (report, file, and the item's own files, Git and Claude setup).
export const TYPE_ICON: Record<AnyType, LucideIcon> = {
  folder: Folder,
  note: FileText,
  report: FileChartColumn,
  file: File,
  daily: CalendarDays,
  chat: Sparkles,
  link: Link2,
  launch: Play,
  group: FolderTree,
  shared: ArrowLeftRight,
  files: FolderOpen,
  git: GitBranch,
  setup: Blocks,
}

export const TYPE_LABEL: Record<AnyType, string> = {
  folder: 'Folder',
  note: 'Note',
  report: 'Report',
  file: 'File',
  daily: 'Daily',
  chat: 'Chat',
  link: 'Link',
  launch: 'Launcher',
  group: 'Group',
  shared: 'Shared',
  files: 'File browser',
  git: 'Git',
  setup: 'Claude setup',
}

const known = new Set<string>(iconNames)
export const isIconName = (name: string) => known.has(name)

/** Claude's spark, or a terminal for the shell. */
export const agentIcon = (agent: Agent | undefined): LucideIcon => (agent === 'shell' ? SquareTerminal : Sparkles)

/** The entry's own lucide icon when it names one, otherwise its type's icon (for a chat, its agent's). */
export function EntryIcon({ type, icon, agent, size = 15 }: { type: AnyType; icon?: string; agent?: Agent; size?: number }) {
  const Fallback = type === 'chat' ? agentIcon(agent) : TYPE_ICON[type]
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
