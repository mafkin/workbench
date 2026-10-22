// Claude's own transcripts, read (never written) for a project's History and for
// counting a chat's messages: <claude dir>/projects/<slug of the folder>/<session>.jsonl,
// one JSON record per line, each with the folder claude ran in as `cwd`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { displayPath, type ClaudeSession } from '../shared/config-schema.ts'

const HEAD = 64 * 1024
const TAIL = 64 * 1024

export const claudeDir = (home: string) => process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')

/** The folder name claude keeps a folder's sessions under: every other character becomes `-`. */
export const slugOf = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-')

export const sessionFile = (home: string, cwd: string, id: string) => path.join(claudeDir(home), 'projects', slugOf(cwd), `${id}.jsonl`)

type Rec = { type?: string; cwd?: string; isMeta?: boolean; toolUseResult?: unknown; message?: { content?: unknown }; customTitle?: string; summary?: string }

/** The text of a prompt you typed; null for commands, meta records and tool results. */
function promptText(r: Rec): string | null {
  if (r.type !== 'user' || r.isMeta || r.toolUseResult !== undefined) return null
  const c = r.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join(' ') : ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean && !clean.startsWith('<') ? clean : null
}

function records(text: string): Rec[] {
  const out: Rec[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a line cut by the head or tail window
    }
  }
  return out
}

async function slice(file: string, size: number, from: 'head' | 'tail'): Promise<string> {
  const fh = await fsp.open(file)
  try {
    const len = Math.min(size, from === 'head' ? HEAD : TAIL)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, from === 'head' ? 0 : size - len)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

/** Sessions claude ran in `dir` (a real path) or below it, newest first. */
export async function sessionsIn(dir: string, home: string, limit = 50): Promise<ClaudeSession[]> {
  const base = path.join(claudeDir(home), 'projects')
  const slug = slugOf(dir)
  let names: string[]
  try {
    names = await fsp.readdir(base)
  } catch {
    return []
  }
  // Slugs lose the difference between / and -, so a match is only a candidate
  // until the transcript's own cwd says it is inside the folder.
  const candidates: { file: string; mtime: number; size: number }[] = []
  for (const name of names.filter((n) => n === slug || n.startsWith(`${slug}-`))) {
    const folder = path.join(base, name)
    let files: string[]
    try {
      files = (await fsp.readdir(folder)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const stat = await fsp.stat(path.join(folder, f)).catch(() => null)
      if (stat?.isFile()) candidates.push({ file: path.join(folder, f), mtime: stat.mtimeMs, size: stat.size })
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  const out: ClaudeSession[] = []
  for (const c of candidates) {
    if (out.length >= limit) break
    const head = records(await slice(c.file, c.size, 'head'))
    const cwd = head.find((r) => typeof r.cwd === 'string')?.cwd
    if (!cwd || !within(cwd, dir)) continue
    const first = head.map(promptText).find((t) => t !== null)
    if (!first) continue
    const tail = c.size > HEAD ? records(await slice(c.file, c.size, 'tail')) : head
    const named = [...head, ...tail].filter((r) => r.type === 'custom-title' && r.customTitle).pop()?.customTitle
    out.push({ id: path.basename(c.file, '.jsonl'), cwd: displayPath(cwd, home), title: (named ?? first).slice(0, 120), mtime: c.mtime })
  }
  return out
}

/**
 * How many prompts you typed in a session; 0 when there is no transcript yet.
 * Never rejects: it runs in the background, and the file can go mid-read.
 */
export async function countPrompts(file: string): Promise<number> {
  let n = 0
  try {
    await fsp.access(file)
    const stream = fs.createReadStream(file, 'utf8')
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.includes('"user"')) continue
      try {
        if (promptText(JSON.parse(line)) !== null) n++
      } catch {
        // a line being written
      }
    }
    return n
  } catch {
    return 0
  }
}
