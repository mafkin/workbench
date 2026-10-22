// Menu entries for picking an agent: plain Claude, each agent profile (with a
// short summary) and optionally the shell. Used by New chat, Chat here, the nav
// menu and the project's default-agent chip.
import { Settings2, ShieldAlert, Sparkles, SquareTerminal } from 'lucide-react'
import { agentSummary, type AgentProfile } from '../../shared/config-schema.ts'
import type { MenuEntry } from '../lib/nav.ts'

interface Options {
  /** The agent to mark (a project's default); plain Claude when unset. */
  current?: string
  /** What the mark says. */
  mark?: string
  shell?: boolean
  run: (agent: string) => void
  /** Adds "Agent profiles…" at the end. */
  edit?: () => void
}

export function agentEntries(agents: Record<string, AgentProfile> | undefined, { current, mark = 'default', shell, run, edit }: Options): (MenuEntry | 'sep')[] {
  const marked = (name: string) => (current ?? 'claude').toLowerCase() === name.toLowerCase()
  const detail = (summary: string, name: string) => [summary, marked(name) ? mark : ''].filter(Boolean).join(' · ') || undefined
  const out: (MenuEntry | 'sep')[] = [{ label: 'Claude', icon: <Sparkles size={14} />, detail: detail('', 'claude'), run: () => run('claude') }]
  for (const [name, a] of Object.entries(agents ?? {})) {
    out.push({
      label: name,
      icon: a.permission === 'bypassPermissions' ? <ShieldAlert size={14} className="bypass-mark" /> : <Sparkles size={14} />,
      detail: detail(agentSummary(a), name),
      run: () => run(name),
    })
  }
  if (shell) out.push({ label: 'Shell', icon: <SquareTerminal size={14} />, run: () => run('shell') })
  if (edit) out.push('sep', { label: 'Agent profiles…', icon: <Settings2 size={14} />, run: edit })
  return out
}
