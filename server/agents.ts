// Agent profiles at chat start: the claude flags a profile stands for, and the
// Claude Code agents (`--agent`) a profile can name, for the editor's suggestions.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expandHome, type AgentProfile } from '../shared/config-schema.ts'
import { claudeDir } from './claude-sessions.ts'

export interface AgentStart {
  args: string[]
  /** The first prompt of a new session. */
  prompt: string | undefined
  bypass: boolean
}

/**
 * The flags for a profile. Lists (`--add-dir`, the tools) take every following
 * word, so they come last; the chat adds its session flag after them, which
 * ends the list before the first prompt.
 */
export function agentArgs(p: AgentProfile, home: string, cwd: string): AgentStart {
  const file = (v: string) => path.resolve(cwd, expandHome(v.trim(), home))
  const args: string[] = []
  // An agent (an orchestrator, say) brings its own model and effort.
  if (p.agent) args.push('--agent', p.agent)
  else {
    if (p.model) args.push('--model', p.model)
    if (p.effort) args.push('--effort', p.effort)
  }
  if (p.permission) args.push('--permission-mode', p.permission)
  if (p.instructions?.trim()) args.push('--append-system-prompt', p.instructions.trim())
  if (p.mcp) args.push('--mcp-config', file(p.mcp))
  const folders = p.folders.map((f) => f.trim()).filter(Boolean)
  if (folders.length) args.push('--add-dir', ...folders.map(file))
  if (p.allowedTools.length) args.push('--allowedTools', ...p.allowedTools)
  if (p.disallowedTools.length) args.push('--disallowedTools', ...p.disallowedTools)
  return { args, prompt: p.prompt?.trim() || undefined, bypass: p.permission === 'bypassPermissions' }
}

async function agentNames(dir: string): Promise<string[]> {
  let files: string[]
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: string[] = []
  for (const f of files) {
    const text = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => '')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
    const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1]
    out.push(name ?? path.basename(f, '.md'))
  }
  return out
}

/** Claude Code agents: yours (`~/.claude/agents`) and the folder's (`.claude/agents`), by name. */
export async function claudeAgents(home: string, dir: string): Promise<string[]> {
  const names = [...(await agentNames(path.join(claudeDir(home), 'agents'))), ...(await agentNames(path.join(dir, '.claude/agents')))]
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}
