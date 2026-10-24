// The right rail (part 12): the tools of the drawer being shown, acting on its
// folder. Files and Git need a folder; Skills, MCP and Settings always show.
// A button opens its tool in the main pane and stays lit while it shows.
import { FolderOpen, GitBranch, Plug, SlidersHorizontal, Sparkles, type LucideIcon } from 'lucide-react'
import type { Drawer } from '../../shared/config-schema.ts'
import { cx, RAIL_TOOLS, type RailTool } from '../lib/nav.ts'

const TOOLS: Record<RailTool, { label: string; icon: LucideIcon; title: (d: Drawer) => string; needsFolder: boolean }> = {
  files: { label: 'Files', icon: FolderOpen, title: (d) => `Files: ${d.folder}`, needsFolder: true },
  git: { label: 'Git', icon: GitBranch, title: (d) => `Git: the repository of ${d.folder}`, needsFolder: true },
  skills: { label: 'Skills', icon: Sparkles, title: (d) => `Skills claude loads in ${d.folder ?? 'every chat'}, and the ones pinned here`, needsFolder: false },
  mcp: { label: 'MCP', icon: Plug, title: (d) => `MCP servers in ${d.folder ?? 'every chat'}, and the ${d.name} drawer's defaults`, needsFolder: false },
  settings: { label: 'Drawer settings', icon: SlidersHorizontal, title: (d) => `Settings of the ${d.name} drawer`, needsFolder: false },
}

interface Props {
  drawer: Drawer | null
  active: RailTool | null
  onPick: (tool: RailTool) => void
}

export function Rail({ drawer, active, onPick }: Props) {
  if (!drawer) return <aside className="rail" aria-label="Drawer tools" />
  return (
    <aside className="rail" aria-label="Drawer tools">
      {RAIL_TOOLS.filter((t) => !TOOLS[t].needsFolder || drawer.folder).map((t) => {
        const tool = TOOLS[t]
        return (
          <button key={t} className={cx('rail-btn', active === t && 'on')} onClick={() => onPick(t)} title={tool.title(drawer)} aria-label={tool.label} aria-pressed={active === t}>
            <tool.icon size={16} />
            <span className="rail-label">{tool.label === 'Drawer settings' ? 'Settings' : tool.label}</span>
          </button>
        )
      })}
    </aside>
  )
}
