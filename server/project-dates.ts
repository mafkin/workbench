// When a project folder was made and last worked on, for its card. Created is
// the folder's birth time (or its oldest top-level file); updated is the last
// git commit in a repository, else the newest file two levels down (not
// counting dotfolders and node_modules).
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface ProjectDates {
  created: number | null
  updated: number | null
  source: 'git' | 'files'
}

const skip = (name: string) => name.startsWith('.') || name === 'node_modules'

function lastCommit(dir: string): Promise<number | null> {
  return new Promise((resolve) =>
    execFile('git', ['-C', dir, 'log', '-1', '--format=%ct'], { timeout: 2000 }, (err, out) => {
      const s = Number(out.trim())
      resolve(err || !s ? null : s * 1000)
    }),
  )
}

export async function projectDates(dir: string): Promise<ProjectDates> {
  const st = await fsp.stat(dir).catch(() => null)
  if (!st?.isDirectory()) return { created: null, updated: null, source: 'files' }
  let newest = 0
  let oldest = Infinity
  const walk = async (d: string, depth: number) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (skip(e.name)) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < 1) await walk(full, depth + 1)
        continue
      }
      const s = await fsp.lstat(full).catch(() => null)
      if (!s) continue
      newest = Math.max(newest, s.mtimeMs)
      if (depth === 0) oldest = Math.min(oldest, s.mtimeMs)
    }
  }
  await walk(dir, 0)
  const created = st.birthtimeMs > 0 ? st.birthtimeMs : Number.isFinite(oldest) ? oldest : null
  const git = (await fsp.stat(path.join(dir, '.git')).catch(() => null)) ? await lastCommit(dir) : null
  if (git) return { created, updated: git, source: 'git' }
  return { created, updated: newest || null, source: 'files' }
}
