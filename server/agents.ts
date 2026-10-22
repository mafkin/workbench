// Agent profiles at chat start: the claude flags a profile stands for, and the
// Claude Code agents (`--agent`) a profile can name, for the editor's suggestions.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expandHome, type AgentProfile } from '../shared/config-schema.ts'
import { claudeDir } from './claude-sessions.ts'
import { frontmatter } from './claude-setup.ts'

/** A profile's context for a chat: folders to add and text to append (server/context.ts). */
export interface ChatContext {
  prompt: string
  dirs: string[]
}

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
export function agentArgs(p: AgentProfile, home: string, cwd: string, context?: ChatContext | null): AgentStart {
  const file = (v: string) => path.resolve(cwd, expandHome(v.trim(), home))
  const args: string[] = []
  // An agent (an orchestrator, say) brings its own model and effort.
  if (p.agent) args.push('--agent', p.agent)
  else {
    if (p.model) args.push('--model', p.model)
    if (p.effort) args.push('--effort', p.effort)
  }
  if (p.permission) args.push('--permission-mode', p.permission)
  // The profile's instructions, then the context: claude takes one --append-system-prompt.
  const instructions = [p.instructions?.trim(), context?.prompt.trim()].filter(Boolean).join('\n\n')
  if (instructions) args.push('--append-system-prompt', instructions)
  if (p.mcp) args.push('--mcp-config', file(p.mcp))
  const folders = [...p.folders.map((f) => f.trim()).filter(Boolean).map(file), ...(context?.dirs ?? [])]
  if (folders.length) args.push('--add-dir', ...folders)
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
    const name = frontmatter(text).data.name
    out.push(typeof name === 'string' && name.trim() ? name.trim() : path.basename(f, '.md'))
  }
  return out
}

/** Claude Code agents: yours (`~/.claude/agents`) and the folder's (`.claude/agents`), by name. */
export async function claudeAgents(home: string, dir: string): Promise<string[]> {
  const names = [...(await agentNames(path.join(claudeDir(home), 'agents'))), ...(await agentNames(path.join(dir, '.claude/agents')))]
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}
