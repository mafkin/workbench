// Git per project (part 9): a project's repository read and changed with the
// git command line, never a shell. Every request names a project of a profile;
// the repository is worked out from its folder, and files, branches, stashes
// and commits a request names must be ones git lists. Hunks are found again by
// their hash before they are applied, so the browser never sends a patch.
//
// Git runs with `core.fsmonitor` off (a repository's config can name a program
// for it, which would run on a plain `git status`), never prompts (no terminal,
// GIT_TERMINAL_PROMPT=0), and with LC_ALL=C so its messages can be read. Reads
// skip optional locks, so polling never holds the index lock your terminal
// wants. Changes to one repository run one at a time.
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { displayPath, type NavItem, type Profile } from '../shared/config-schema.ts'
import type {
  Branch,
  Commit,
  CommitDetail,
  CommitFile,
  DiffLine,
  DiscardResult,
  GitConflict,
  GitDiff,
  GitFile,
  GitFileState,
  GitMark,
  GitOperation,
  GitStatus,
  Hunk,
  Stash,
} from '../shared/git.ts'
import { StoreError, type ConfigStore } from './config-store.ts'
import { runToExit } from './launch.ts'
import { maskText } from './mask.ts'
import { absPath, realish } from './paths.ts'
import { findTrashed, untrash } from './trash.ts'

type Folder = Extract<NavItem, { type: 'folder' }>

export interface GitOptions {
  /** For `gio trash` (discarding an untracked file); tests pass a stand-in. */
  spawn?: typeof nodeSpawn
  /** Runs `claude -p` with the prompt and the diff on stdin; gives its answer. */
  draft?: (cwd: string, prompt: string, input: string) => Promise<string>
  /** How often the active profile's repositories are fetched; 0 for never. */
  fetchEveryMs?: number
  /** Which profile is active, for the background fetch. */
  activeProfile?: () => string | null
}

export interface Repo {
  /** The folder entry this came from. */
  project: Folder
  /** The project folder, resolved. */
  dir: string
  /** The repository's top folder. */
  root: string
  gitDir: string
}

interface Run {
  code: number
  stdout: string
  stderr: string
}

interface RunOpts {
  input?: string
  /** A change, not a read: takes optional locks. */
  write?: boolean
  network?: boolean
  timeoutMs?: number
  /** Exit codes that are not failures (`git diff --no-index` exits 1 on a difference). */
  ok?: number[]
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_DIFF = 1024 * 1024
const MAX_DIFF_LINES = 5000
const MAX_OUTPUT = 32 * 1024 * 1024
const MAX_DRAFT_DIFF = 60_000
const UNDO_FOR_MS = 60 * 60_000
const HEX = /^[0-9a-f]{4,64}$/
const MARKERS = /^(<{7}|>{7})( |$)|^={7}$/m
/** Variables that would point git at another repository than the one asked for. */
const REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']

/** The folder entries of a profile, groups included. */
export function projectsOf(profile: Profile): Folder[] {
  const out: Folder[] = []
  for (const section of profile.sections) {
    for (const item of section.items) {
      if (item.type === 'folder') out.push(item)
      if (item.type === 'group') for (const child of item.items) if (child.type === 'folder') out.push(child)
    }
  }
  return out
}

/** A path inside the repository as a request gives it: relative, `/`-separated, no `..`. */
export function repoPath(raw: string): string {
  const p = path.posix.normalize(raw.replace(/\\/g, '/'))
  if (!raw || raw.includes('\0') || path.posix.isAbsolute(p) || p === '..' || p.startsWith('../') || p === '.') {
    throw new StoreError('Not a file in this repository', 400)
  }
  return p.replace(/\/$/, '')
}

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16)

// Parsing

interface StatusRead {
  oid: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFile[]
  changes: GitFile[]
  conflicts: GitConflict[]
}

/** `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): StatusRead {
  const r: StatusRead = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0, staged: [], changes: [], conflicts: [] }
  const parts = out.split('\0')
  const state = (c: string) => c as GitFileState
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (!e) continue
    if (e.startsWith('# ')) {
      const [key, ...rest] = e.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') r.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') r.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') r.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) [r.ahead, r.behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    const f = e.split(' ')
    if (e[0] === '1' || e[0] === '2') {
      const [x, y] = f[1]
      const file = f.slice(e[0] === '1' ? 8 : 9).join(' ')
      const from = e[0] === '2' ? parts[++i] : undefined
      if (x !== '.') r.staged.push({ path: file, state: state(x), ...(from && (x === 'R' || x === 'C') ? { from } : {}) })
      if (y !== '.') r.changes.push({ path: file, state: state(y), ...(from && (y === 'R' || y === 'C') ? { from } : {}) })
    } else if (e[0] === 'u') {
      r.conflicts.push({ path: f.slice(10).join(' '), code: f[1] })
    } else if (e[0] === '?') {
      r.changes.push({ path: e.slice(2), state: '?' })
    }
  }
  return r
}

interface ParsedDiff {
  head: string[]
  binary: boolean
  hunks: (Hunk & { raw: string })[]
}

/** One file's unified diff: its header lines and its hunks, each with a hash to find it by. */
export function parseDiff(file: string, text: string): ParsedDiff {
  const out: ParsedDiff = { head: [], binary: false, hunks: [] }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  let cur: { header: string; raw: string[]; lines: DiffLine[]; old: number; new: number } | null = null
  const close = () => {
    if (!cur) return
    const raw = `${cur.raw.join('\n')}\n`
    out.hunks.push({ id: hashOf(`${file}\0${raw}`), header: cur.header, lines: cur.lines, raw })
    cur = null
  }
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      close()
      cur = { header: line, raw: [line], lines: [], old: Number(m[1]), new: Number(m[2]) }
      continue
    }
    if (!cur) {
      if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') out.binary = true
      out.head.push(line)
      continue
    }
    const kind = line[0] as DiffLine['kind']
    if (kind !== ' ' && kind !== '+' && kind !== '-' && kind !== '\\') continue
    cur.raw.push(line)
    const text = line.slice(1)
    if (kind === ' ') cur.lines.push({ kind, text, old: cur.old++, new: cur.new++ })
    else if (kind === '-') cur.lines.push({ kind, text, old: cur.old++ })
    else if (kind === '+') cur.lines.push({ kind, text, new: cur.new++ })
    else cur.lines.push({ kind, text: line.slice(2) })
  }
  close()
  return out
}

/** `git diff --numstat -z` and `--name-status -z` of a commit, as one list. */
export function parseCommitFiles(numstat: string, nameStatus: string): CommitFile[] {
  const files: CommitFile[] = []
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i]
    if (!code) continue
    const letter = code[0] as GitFileState
    if (letter === 'R' || letter === 'C') {
      files.push({ state: letter, from: ns[i + 1], path: ns[i + 2], added: null, removed: null })
      i += 2
    } else {
      files.push({ state: letter, path: ns[i + 1], added: null, removed: null })
      i += 1
    }
  }
  const nums = numstat.split('\0')
  for (let i = 0; i < nums.length; i++) {
    const rec = nums[i]
    if (!rec) continue
    const [a, r, p] = rec.split('\t')
    let file = p
    // A rename: an empty path, then the old and new paths.
    if (p === '') {
      file = nums[i + 2]
      i += 2
    }
    const hit = files.find((f) => f.path === file)
    if (hit) {
      hit.added = a === '-' ? null : Number(a)
      hit.removed = r === '-' ? null : Number(r)
    }
  }
  return files
}

const COMMIT_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%s%x1e'

function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, at, parents, subject] = r.split('\x1f')
      return { hash, short, author, email, at: Number(at), parents: parents ? parents.split(' ') : [], subject }
    })
}

export class Git {
  #store: ConfigStore
  #home: string
  #spawn: typeof nodeSpawn | undefined
  #draft: GitOptions['draft']
  #repos = new Map<string, { at: number; root: string; gitDir: string } | { at: number; root: null }>()
  #locks = new Map<string, Promise<unknown>>()
  #fetched = new Map<string, { at: number; error: string | null }>()
  #undos = new Map<string, { at: number; root: string; files: { file: string; blob: string | null; mode: number | null; after: string | null }[]; trashed: string[] }>()
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(store: ConfigStore, home: string, opts: GitOptions = {}) {
    this.#store = store
    this.#home = home
    this.#spawn = opts.spawn
    this.#draft = opts.draft
    if (opts.fetchEveryMs && opts.activeProfile) {
      const active = opts.activeProfile
      this.#timer = setInterval(() => {
        const id = active()
        if (id) void this.fetchAll(id, opts.fetchEveryMs! / 2)
      }, opts.fetchEveryMs)
      this.#timer.unref()
    }
  }

  close() {
    if (this.#timer) clearInterval(this.#timer)
  }

  // Running git

  #env(opts: RunOpts): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.#home,
      LC_ALL: 'C',
      LANGUAGE: '',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
    }
    for (const key of REDIRECTS) delete env[key]
    if (!opts.write) env.GIT_OPTIONAL_LOCKS = '0'
    // Under systemd the session's SSH agent may not be in the environment; GNOME's is at a known place.
    if (opts.network && !env.SSH_AUTH_SOCK && env.XDG_RUNTIME_DIR) {
      for (const sock of ['gcr/ssh', 'keyring/ssh']) {
        const p = path.join(env.XDG_RUNTIME_DIR, sock)
        if (fs.existsSync(p)) {
          env.SSH_AUTH_SOCK = p
          break
        }
      }
    }
    return env
  }

  run(cwd: string, args: string[], opts: RunOpts = {}): Promise<Run> {
    const argv = ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args]
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('git', argv, { env: this.#env(opts), stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? (opts.network ? 120_000 : 15_000))
      child.stdout.on('data', (d: Buffer) => {
        size += d.length
        if (size > MAX_OUTPUT) child.kill('SIGTERM')
        else out.push(d)
      })
      child.stderr.on('data', (d: Buffer) => err.push(d))
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(new StoreError(e.code === 'ENOENT' ? 'git is not installed' : e.message, 500))
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        if (signal) return reject(new StoreError(size > MAX_OUTPUT ? 'git gave too much output' : `git ${args[0]} took too long and was stopped`, 504))
        resolve({ code: code ?? 1, stdout, stderr })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input ?? '')
    })
  }

  /** Run git and fail with its own message on a non-zero exit. */
  async #git(cwd: string, args: string[], opts: RunOpts = {}): Promise<string> {
    const r = await this.run(cwd, args, opts)
    if (r.code !== 0 && !(opts.ok ?? []).includes(r.code)) throw new StoreError(gitMessage(r, args[0]), 422)
    return r.stdout
  }

  /** One change at a time per repository. */
  #lock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(root) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.#locks.set(root, tail)
    void tail.then(() => this.#locks.get(root) === tail && this.#locks.delete(root))
    return next
  }

  // Finding the repository

  /** A project of the profile, by its path as written in the config, with its repository; null if it isn't in one. */
  async repo(profileId: string, projectPath: string): Promise<Repo | null> {
    const p = this.#store.profile(profileId)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    const project = projectsOf(p.profile).find((f) => f.path === projectPath)
    if (!project) throw new StoreError('Not a project of this profile', 404)
    const dir = await realish(absPath(project.path, this.#home))
    const found = await this.#rootOf(dir)
    return found && { project, dir, ...found }
  }

  /** Like `repo`, for the routes that need one. */
  async need(profileId: string, projectPath: string): Promise<Repo> {
    const r = await this.repo(profileId, projectPath)
    if (!r) throw new StoreError('This project is not in a git repository', 404)
    return r
  }

  async #rootOf(dir: string): Promise<{ root: string; gitDir: string } | null> {
    const hit = this.#repos.get(dir)
    if (hit && Date.now() - hit.at < 30_000) return hit.root ? { root: hit.root, gitDir: hit.gitDir } : null
    let found: { root: string; gitDir: string } | null = null
    if ((await fsp.stat(dir).catch(() => null))?.isDirectory()) {
      const r = await this.run(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
      const [root, gitDir] = r.stdout.trim().split('\n')
      if (r.code === 0 && root && gitDir) found = { root: await fsp.realpath(root).catch(() => root), gitDir }
    }
    this.#repos.set(dir, found ? { at: Date.now(), ...found } : { at: Date.now(), root: null })
    return found
  }

  // Status

  async #read(root: string, untracked: 'all' | 'normal' = 'all'): Promise<StatusRead> {
    return parseStatus(await this.#git(root, ['status', '--porcelain=v2', '--branch', '-z', `--untracked-files=${untracked}`]))
  }

  async status(r: Repo): Promise<GitStatus> {
    const [s, remotes, stashes, operation] = await Promise.all([this.#read(r.root), this.#remotes(r.root), this.stashes(r), this.#operation(r)])
    const headPushed = s.oid ? (await this.#git(r.root, ['branch', '-r', '--contains', 'HEAD', '--format=%(refname)'])).trim() !== '' : false
    const op: GitOperation = operation.kind ?? (s.conflicts.length ? 'stash' : null)
    return {
      repo: displayPath(r.root, this.#home),
      sub: r.dir === r.root ? '' : `${path.relative(r.root, r.dir)}/`,
      branch: s.branch,
      head: s.oid?.slice(0, 7) ?? null,
      upstream: s.upstream,
      ahead: s.ahead,
      behind: s.behind,
      remotes,
      staged: s.staged,
      changes: s.changes,
      conflicts: s.conflicts,
      operation: op,
      operationLabel: operation.label,
      stashes,
      headPushed,
      lastFetch: this.#fetched.get(r.root) ?? null,
    }
  }

  async #remotes(root: string): Promise<string[]> {
    return (await this.#git(root, ['remote'])).split('\n').filter(Boolean)
  }

  async #operation(r: Repo): Promise<{ kind: GitOperation; label: string | null }> {
    const has = (f: string) => fs.existsSync(path.join(r.gitDir, f))
    if (has('MERGE_HEAD')) {
      const msg = await fsp.readFile(path.join(r.gitDir, 'MERGE_MSG'), 'utf8').catch(() => '')
      const first = msg.split('\n')[0]
      return { kind: 'merge', label: first ? first.split(this.#home + '/').join('~/') : null }
    }
    if (has('rebase-merge') || has('rebase-apply')) return { kind: 'rebase', label: null }
    if (has('CHERRY_PICK_HEAD')) return { kind: 'cherry-pick', label: null }
    if (has('REVERT_HEAD')) return { kind: 'revert', label: null }
    return { kind: null, label: null }
  }

  /** Branch and counts for each project of the profile that is in a repository. */
  async marks(profileId: string): Promise<GitMark[]> {
    const p = this.#store.profile(profileId)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    const byRoot = new Map<string, Promise<StatusRead | null>>()
    const out: GitMark[] = []
    await Promise.all(
      projectsOf(p.profile).map(async (project) => {
        let dir: string
        try {
          dir = await realish(absPath(project.path, this.#home))
        } catch {
          return
        }
        const found = await this.#rootOf(dir)
        if (!found) return
        if (!byRoot.has(found.root)) byRoot.set(found.root, this.#read(found.root, 'normal').catch(() => null))
        const s = await byRoot.get(found.root)!
        if (!s) return
        const changed = new Set([...s.staged, ...s.changes].map((f) => f.path)).size
        out.push({ path: project.path, branch: s.branch, changed, ahead: s.ahead, behind: s.behind, conflicts: s.conflicts.length })
      }),
    )
    return out
  }

  // Diffs and hunks

  async #rawDiff(r: Repo, file: string, staged: boolean): Promise<{ text: string; untracked: boolean; from?: string; conflict: boolean }> {
    const s = await this.#read(r.root)
    if (s.conflicts.some((c) => c.path === file)) {
      // A conflicted file against HEAD: its conflict markers show as added lines.
      return { text: await this.#git(r.root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file]), untracked: false, conflict: true }
    }
    const entry = (staged ? s.staged : s.changes).find((f) => f.path === file)
    if (!entry) throw new StoreError(`${file} has no ${staged ? 'staged ' : ''}changes`, 409)
    if (entry.state === '?') {
      const st = await fsp.stat(path.join(r.root, file)).catch(() => null)
      if (st && st.size > MAX_DIFF) return { text: '', untracked: true, conflict: false }
      const text = await this.#git(r.root, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', file], { ok: [1] })
      return { text, untracked: true, conflict: false }
    }
    const paths = entry.from ? [entry.from, file] : [file]
    const text = await this.#git(r.root, ['diff', '--no-ext-diff', '--no-textconv', '-M', ...(staged ? ['--cached'] : []), '--', ...paths])
    return { text, untracked: false, from: entry.from, conflict: false }
  }

  async diff(r: Repo, rawFile: string, staged: boolean): Promise<GitDiff> {
    const file = repoPath(rawFile)
    const d = await this.#rawDiff(r, file, staged)
    return shapeDiff(file, d.text, { untracked: d.untracked || d.conflict, from: d.from, large: d.untracked && !d.text })
  }

  /** Find a hunk again by its id and apply it: stage, unstage or discard. */
  async #applyHunk(r: Repo, file: string, id: string, how: 'stage' | 'unstage' | 'discard'): Promise<void> {
    const d = await this.#rawDiff(r, file, how === 'unstage')
    if (d.untracked || d.conflict) throw new StoreError('This file only works as a whole', 422)
    const parsed = parseDiff(file, d.text)
    const hunk = parsed.hunks.find((h) => h.id === id)
    if (!hunk) throw new StoreError('The file changed since; showing it again', 409)
    const patch = `${parsed.head.join('\n')}\n${hunk.raw}`
    const args = how === 'stage' ? ['apply', '--cached'] : how === 'unstage' ? ['apply', '--cached', '-R'] : ['apply', '-R']
    await this.#git(r.root, [...args, '--whitespace=nowarn', '-'], { input: patch, write: true })
  }

  async stage(r: Repo, req: { files?: string[]; all?: boolean; hunk?: { file: string; id: string } }): Promise<void> {
    await this.#lock(r.root, async () => {
      if (req.hunk) return this.#applyHunk(r, repoPath(req.hunk.file), req.hunk.id, 'stage')
      if (req.all) return void (await this.#git(r.root, ['add', '-A'], { write: true }))
      const s = await this.#read(r.root)
      const files = (req.files ?? []).map(repoPath)
      for (const f of files) if (!s.changes.some((c) => c.path === f)) throw new StoreError(`${f} has no changes to stage`, 409)
      if (files.length) await this.#git(r.root, ['add', '-A', '--', ...files], { write: true })
    })
  }

  async unstage(r: Repo, req: { files?: string[]; all?: boolean; hunk?: { file: string; id: string } }): Promise<void> {
    await this.#lock(r.root, async () => {
      if (req.hunk) return this.#applyHunk(r, repoPath(req.hunk.file), req.hunk.id, 'unstage')
      const s = await this.#read(r.root)
      const paths = req.all
        ? s.staged.flatMap((f) => (f.from ? [f.from, f.path] : [f.path]))
        : (req.files ?? []).map(repoPath).flatMap((f) => {
            const hit = s.staged.find((x) => x.path === f)
            if (!hit) throw new StoreError(`${f} is not staged`, 409)
            return hit.from ? [hit.from, hit.path] : [hit.path]
          })
      if (!paths.length) return
      if (s.oid) await this.#git(r.root, ['reset', '-q', 'HEAD', '--', ...paths], { write: true })
      else await this.#git(r.root, ['rm', '-q', '-r', '--cached', '--', ...paths], { write: true })
    })
  }

  /** The file's content kept in git's object store, so a discard can be undone. */
  async #keep(root: string, file: string): Promise<{ blob: string | null; mode: number | null }> {
    const abs = path.join(root, file)
    const st = await fsp.lstat(abs).catch(() => null)
    if (!st || !st.isFile()) return { blob: null, mode: null }
    return { blob: (await this.#git(root, ['hash-object', '-w', '--', file], { write: true })).trim(), mode: st.mode & 0o777 }
  }

  async #hashNow(root: string, file: string): Promise<string | null> {
    const st = await fsp.lstat(path.join(root, file)).catch(() => null)
    if (!st || !st.isFile()) return null
    return (await this.#git(root, ['hash-object', '--', file])).trim()
  }

  /** Throw away changes in the work tree: tracked files can be had back with Undo; untracked ones go to the Trash. */
  async discard(r: Repo, req: { files?: string[]; hunk?: { file: string; id: string } }): Promise<DiscardResult> {
    return this.#lock(r.root, async () => {
      const kept: { file: string; blob: string | null; mode: number | null; after: string | null }[] = []
      const trashed: string[] = []
      if (req.hunk) {
        const file = repoPath(req.hunk.file)
        const before = await this.#keep(r.root, file)
        await this.#applyHunk(r, file, req.hunk.id, 'discard')
        kept.push({ file, ...before, after: await this.#hashNow(r.root, file) })
      } else {
        const s = await this.#read(r.root)
        const files = (req.files ?? []).map(repoPath)
        const entries = files.map((f) => {
          const hit = s.changes.find((c) => c.path === f)
          if (!hit) throw new StoreError(`${f} has no changes to discard`, 409)
          return hit
        })
        const untracked = entries.filter((e) => e.state === '?').map((e) => e.path)
        const tracked = entries.filter((e) => e.state !== '?').map((e) => e.path)
        for (const file of tracked) kept.push({ file, ...(await this.#keep(r.root, file)), after: null })
        if (tracked.length) await this.#git(r.root, ['checkout', '-q', '--', ...tracked], { write: true })
        for (const k of kept) k.after = await this.#hashNow(r.root, k.file)
        if (untracked.length) {
          await runToExit({ command: 'gio', args: ['trash', '--', ...untracked.map((f) => path.join(r.root, f))] }, this.#spawn)
          trashed.push(...untracked)
        }
      }
      for (const [id, u] of this.#undos) if (Date.now() - u.at > UNDO_FOR_MS) this.#undos.delete(id)
      const id = randomUUID()
      this.#undos.set(id, { at: Date.now(), root: r.root, files: kept, trashed })
      return { undo: kept.length || trashed.length ? id : null, trashed }
    })
  }

  /** Put back what a discard threw away, if the files haven't changed since. */
  async undoDiscard(r: Repo, id: string): Promise<{ restored: string[]; skipped: { path: string; reason: string }[] }> {
    const u = this.#undos.get(id)
    if (!u || u.root !== r.root) throw new StoreError('Nothing to undo', 404)
    return this.#lock(r.root, async () => {
      const restored: string[] = []
      const skipped: { path: string; reason: string }[] = []
      for (const f of u.files) {
        if ((await this.#hashNow(r.root, f.file)) !== f.after) {
          skipped.push({ path: f.file, reason: 'It changed since' })
          continue
        }
        const abs = path.join(r.root, f.file)
        if (f.blob === null) await fsp.rm(abs, { force: true })
        else {
          const content = await this.#blob(r.root, f.blob)
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          await fsp.writeFile(abs, content, { mode: f.mode ?? 0o644 })
          if (f.mode !== null) await fsp.chmod(abs, f.mode)
        }
        restored.push(f.file)
      }
      for (const file of u.trashed) {
        const abs = path.join(r.root, file)
        const found = await findTrashed(abs, this.#home)
        if (!found) skipped.push({ path: file, reason: 'It is not in the Trash' })
        else if (fs.existsSync(abs)) skipped.push({ path: file, reason: 'Something else is there now' })
        else {
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          await untrash(found, abs)
          restored.push(file)
        }
      }
      this.#undos.delete(id)
      return { restored, skipped }
    })
  }

  #blob(root: string, blob: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('git', ['-C', root, 'cat-file', 'blob', blob], { env: this.#env({}), stdio: ['ignore', 'pipe', 'ignore'] })
      const out: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new StoreError('The kept copy is gone', 410))))
    })
  }

  // Commit

  async commit(r: Repo, message: string, amend: boolean): Promise<Commit> {
    if (!message.trim()) throw new StoreError('Write a commit message first', 400)
    return this.#lock(r.root, async () => {
      const s = await this.status(r)
      if (s.conflicts.length) throw new StoreError('Resolve the conflicts first', 409)
      if (amend && !s.head) throw new StoreError('There is no commit to amend yet', 422)
      if (amend && s.headPushed) throw new StoreError('The last commit is already pushed; amending it here is not offered', 409)
      if (!amend && !s.staged.length) throw new StoreError('Nothing is staged', 422)
      await this.#git(r.root, ['commit', '-q', '--cleanup=strip', '-F', '-', ...(amend ? ['--amend'] : [])], { input: message, write: true, timeoutMs: 120_000 })
      return (await this.log(r, 0, 1))[0]
    })
  }

  /** A commit message for what is staged, from claude; it never commits. */
  async draft(r: Repo): Promise<string> {
    if (!this.#draft) throw new StoreError('Drafting is not available', 501)
    let diff = await this.#git(r.root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '-M'])
    if (!diff.trim()) throw new StoreError('Stage something first', 422)
    const stat = await this.#git(r.root, ['diff', '--cached', '--stat', '-M'])
    if (diff.length > MAX_DRAFT_DIFF) diff = `${diff.slice(0, MAX_DRAFT_DIFF)}\n[… the rest of the diff is left out]\n`
    const recent = (await this.run(r.root, ['log', '-10', '--format=%s'])).stdout.split('\n').filter(Boolean)
    const prompt = [
      'Write a git commit message for the staged changes. The diff is on stdin.',
      'Reply with the message only: a subject line of at most 72 characters, then, if it helps, a blank line and a short body. No quotes, no code fences.',
      recent.length ? `Match the style of this repository's recent commit subjects:\n${recent.map((s) => `- ${s}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const answer = await this.#draft(r.root, prompt, `${stat}\n${diff}`)
    const message = answer
      .trim()
      .replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1')
      .trim()
    if (!message) throw new StoreError('claude gave no message', 502)
    return message
  }

  // Branches

  async branches(r: Repo): Promise<Branch[]> {
    const fmt = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(HEAD)', '%(subject)'].join('%1f')
    const out = await this.#git(r.root, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes'])
    const list: Branch[] = []
    for (const line of out.split('\n')) {
      if (!line) continue
      const [ref, name, upstream, track, at, head, subject] = line.split('\x1f')
      if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) continue
      const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
      const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
      list.push({ name, remote: ref.startsWith('refs/remotes/'), current: head === '*', upstream: upstream || null, ahead, behind, at: Number(at) || 0, subject })
    }
    return list
  }

  async #branchName(r: Repo, raw: string): Promise<string> {
    const name = raw.trim()
    if (!name || name.startsWith('-')) throw new StoreError('Not a branch name', 400)
    const res = await this.run(r.root, ['check-ref-format', '--branch', name])
    if (res.code !== 0) throw new StoreError(`${name} is not a valid branch name`, 400)
    return res.stdout.trim()
  }

  async switchTo(r: Repo, name: string, carry?: 'carry' | 'stash'): Promise<void> {
    await this.#lock(r.root, async () => {
      const list = await this.branches(r)
      const b = list.find((x) => x.name === name)
      if (!b) throw new StoreError(`No branch named ${name}`, 404)
      if (b.current) return
      const s = await this.#read(r.root)
      if (s.conflicts.length) throw new StoreError('Resolve the conflicts first', 409)
      if ((s.staged.length || s.changes.length) && !carry) throw new StoreError('You have uncommitted changes', 409, { dirty: true })
      if (carry === 'stash' && (s.staged.length || s.changes.length)) {
        await this.#git(r.root, ['stash', 'push', '-u', '-m', `Before switching to ${name}`], { write: true })
      }
      if (!b.remote) return void (await this.#git(r.root, ['switch', '-q', name], { write: true }))
      const local = name.slice(name.indexOf('/') + 1)
      if (list.some((x) => !x.remote && x.name === local)) await this.#git(r.root, ['switch', '-q', local], { write: true })
      else await this.#git(r.root, ['switch', '-q', '--track', `refs/remotes/${name}`], { write: true })
    })
  }

  async createBranch(r: Repo, raw: string): Promise<void> {
    const name = await this.#branchName(r, raw)
    await this.#lock(r.root, async () => {
      if ((await this.branches(r)).some((b) => !b.remote && b.name === name)) throw new StoreError(`${name} already exists`, 409)
      await this.#git(r.root, ['switch', '-q', '-c', name], { write: true })
    })
  }

  async renameBranch(r: Repo, from: string, raw: string): Promise<void> {
    const name = await this.#branchName(r, raw)
    await this.#lock(r.root, async () => {
      const list = await this.branches(r)
      if (!list.some((b) => !b.remote && b.name === from)) throw new StoreError(`No branch named ${from}`, 404)
      if (list.some((b) => !b.remote && b.name === name)) throw new StoreError(`${name} already exists`, 409)
      await this.#git(r.root, ['branch', '-m', from, name], { write: true })
    })
  }

  /** Delete a local branch; an unmerged one needs `force`, after naming what would be lost. */
  async deleteBranch(r: Repo, name: string, force: boolean): Promise<void> {
    await this.#lock(r.root, async () => {
      const b = (await this.branches(r)).find((x) => !x.remote && x.name === name)
      if (!b) throw new StoreError(`No branch named ${name}`, 404)
      if (b.current) throw new StoreError('Switch to another branch first', 409)
      const res = await this.run(r.root, ['branch', force ? '-D' : '-d', name], { write: true })
      if (res.code === 0) return
      if (/not fully merged/.test(res.stderr)) {
        const lost = parseLog(await this.#git(r.root, ['log', `--format=${COMMIT_FORMAT}`, '-n', '20', `refs/heads/${name}`, '--not', 'HEAD', '--remotes']))
        throw new StoreError(`${name} has commits that aren't merged`, 409, { confirm: true, lost: lost.map((c) => `${c.short} ${c.subject}`) })
      }
      throw new StoreError(gitMessage(res, 'branch'), 422)
    })
  }

  // Stash

  async stashes(r: Repo): Promise<Stash[]> {
    const out = await this.#git(r.root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ct%x1f%gs%x1e'])
    return out
      .split('\x1e')
      .map((x) => x.replace(/^\n/, ''))
      .filter(Boolean)
      .map((rec) => {
        const [ref, hash, at, message] = rec.split('\x1f')
        return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0), hash, at: Number(at), message }
      })
  }

  async stash(r: Repo, req: { action: 'push' | 'pop' | 'apply' | 'drop'; index?: number; hash?: string; message?: string }): Promise<{ conflicts: boolean }> {
    return this.#lock(r.root, async () => {
      if (req.action === 'push') {
        const s = await this.#read(r.root)
        if (!s.staged.length && !s.changes.length) throw new StoreError('There is nothing to stash', 422)
        if (s.conflicts.length) throw new StoreError('Resolve the conflicts first', 409)
        const msg = req.message?.trim()
        await this.#git(r.root, ['stash', 'push', '-u', ...(msg ? ['-m', msg] : [])], { write: true })
        return { conflicts: false }
      }
      const found = (await this.stashes(r)).find((x) => x.index === req.index)
      if (!found || found.hash !== req.hash) throw new StoreError('The stash list changed; showing it again', 409)
      const ref = `stash@{${found.index}}`
      if (req.action === 'drop') {
        await this.#git(r.root, ['stash', 'drop', '-q', ref], { write: true })
        return { conflicts: false }
      }
      const res = await this.run(r.root, ['stash', req.action, ref], { write: true })
      if (res.code === 0) return { conflicts: false }
      if ((await this.#read(r.root)).conflicts.length) return { conflicts: true }
      throw new StoreError(gitMessage(res, 'stash'), 422)
    })
  }

  // Remote

  async fetch(r: Repo, { quiet = false } = {}): Promise<void> {
    if (!(await this.#remotes(r.root)).length) {
      if (quiet) return
      throw new StoreError('This repository has no remote', 422)
    }
    const run = async () => {
      const res = await this.run(r.root, ['fetch', '--all', '--prune', '--quiet'], { write: true, network: true })
      const error = res.code === 0 ? null : gitMessage(res, 'fetch')
      this.#fetched.set(r.root, { at: Date.now(), error })
      if (error && !quiet) throw new StoreError(error, 502)
    }
    // A background fetch gives way to anything else running.
    if (quiet && this.#locks.has(r.root)) return
    await this.#lock(r.root, run)
  }

  /** Fetch the profile's repositories that have a remote, unless fetched within `freshMs`. */
  async fetchAll(profileId: string, freshMs = 0): Promise<void> {
    const p = this.#store.profile(profileId)
    if (!p.profile) return
    const seen = new Set<string>()
    for (const project of projectsOf(p.profile)) {
      const r = await this.repo(profileId, project.path).catch(() => null)
      if (!r || seen.has(r.root)) continue
      seen.add(r.root)
      const last = this.#fetched.get(r.root)
      if (last && Date.now() - last.at < freshMs) continue
      await this.fetch(r, { quiet: true }).catch(() => {})
    }
  }

  async pull(r: Repo, merge: boolean): Promise<{ conflicts: boolean }> {
    return this.#lock(r.root, async () => {
      const s = await this.#read(r.root)
      if (!s.branch) throw new StoreError('HEAD is detached; switch to a branch first', 422)
      if (!s.upstream) throw new StoreError(`${s.branch} has no upstream to pull from`, 422)
      if (s.conflicts.length) throw new StoreError('Resolve the conflicts first', 409)
      const args = merge ? ['pull', '--no-rebase', '--no-edit'] : ['pull', '--ff-only']
      const res = await this.run(r.root, args, { write: true, network: true })
      this.#fetched.set(r.root, { at: Date.now(), error: null })
      if (res.code === 0) return { conflicts: false }
      if (merge && (await this.#read(r.root)).conflicts.length) return { conflicts: true }
      if (!merge && /Not possible to fast-forward|diverg/i.test(res.stderr)) {
        throw new StoreError(`${s.branch} and ${s.upstream} have both moved on; merge them to pull`, 409, { diverged: true })
      }
      throw new StoreError(gitMessage(res, 'pull'), 422)
    })
  }

  /** Push the branch; one without an upstream is published to a remote with `publish`. */
  async push(r: Repo, publish: boolean): Promise<void> {
    await this.#lock(r.root, async () => {
      const s = await this.#read(r.root)
      if (!s.branch) throw new StoreError('HEAD is detached; switch to a branch first', 422)
      const remotes = await this.#remotes(r.root)
      if (!remotes.length) throw new StoreError('This repository has no remote', 422)
      let args = ['push', '--quiet']
      if (!s.upstream) {
        const remote = remotes.includes('origin') ? 'origin' : remotes[0]
        if (!publish) throw new StoreError(`${s.branch} is not on ${remote} yet`, 409, { publish: true, remote })
        args = ['push', '--quiet', '-u', remote, `refs/heads/${s.branch}:refs/heads/${s.branch}`]
      }
      const res = await this.run(r.root, args, { write: true, network: true })
      if (res.code !== 0) {
        const rejected = /\[rejected\]|non-fast-forward|fetch first/.test(res.stderr)
        throw new StoreError(rejected ? `The remote has commits you don't have yet; pull first` : gitMessage(res, 'push'), rejected ? 409 : 422)
      }
    })
  }

  // Conflicts

  async resolve(r: Repo, rawFile: string, force: boolean): Promise<void> {
    const file = repoPath(rawFile)
    await this.#lock(r.root, async () => {
      const s = await this.#read(r.root)
      if (!s.conflicts.some((c) => c.path === file)) throw new StoreError(`${file} has no conflict`, 409)
      const abs = path.join(r.root, file)
      const st = await fsp.stat(abs).catch(() => null)
      if (st?.isFile() && st.size < 8 * 1024 * 1024 && !force) {
        if (MARKERS.test(await fsp.readFile(abs, 'utf8'))) throw new StoreError(`${file} still has conflict markers`, 409, { confirm: true })
      }
      await this.#git(r.root, ['add', '-A', '--', file], { write: true })
    })
  }

  async abort(r: Repo): Promise<void> {
    await this.#lock(r.root, async () => {
      if ((await this.#operation(r)).kind !== 'merge') throw new StoreError('No merge is in progress', 409)
      await this.#git(r.root, ['merge', '--abort'], { write: true })
    })
  }

  // History

  async log(r: Repo, skip = 0, count = 200): Promise<Commit[]> {
    // No commits yet: no history.
    if ((await this.run(r.root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) return []
    return parseLog(await this.#git(r.root, ['log', `--format=${COMMIT_FORMAT}`, '-n', String(count), '--skip', String(skip), 'HEAD', '--']))
  }

  async #commitHash(r: Repo, raw: string): Promise<string> {
    if (!HEX.test(raw)) throw new StoreError('Not a commit', 400)
    const res = await this.run(r.root, ['rev-parse', '--verify', '--quiet', `${raw}^{commit}`])
    if (res.code !== 0) throw new StoreError('No such commit', 404)
    return res.stdout.trim()
  }

  async commitDetail(r: Repo, raw: string): Promise<CommitDetail> {
    const hash = await this.#commitHash(r, raw)
    const show = await this.#git(r.root, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%P%x1f%s%x1f%b', hash])
    const [h, short, author, email, at, committer, committedAt, parents, subject, body] = show.split('\x1f')
    const parentList = parents ? parents.split(' ') : []
    const base = parentList[0] ?? EMPTY_TREE
    const [numstat, nameStatus] = await Promise.all([
      this.#git(r.root, ['diff', '--no-ext-diff', '-M', '--numstat', '-z', base, hash]),
      this.#git(r.root, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', base, hash]),
    ])
    return {
      hash: h,
      short,
      author,
      email,
      at: Number(at),
      committer,
      committedAt: Number(committedAt),
      parents: parentList,
      subject,
      body: (body ?? '').trim(),
      files: parseCommitFiles(numstat, nameStatus),
    }
  }

  async commitDiff(r: Repo, raw: string, rawFile: string): Promise<GitDiff> {
    const file = repoPath(rawFile)
    const detail = await this.commitDetail(r, raw)
    const entry = detail.files.find((f) => f.path === file)
    if (!entry) throw new StoreError(`${file} did not change in this commit`, 404)
    const base = detail.parents[0] ?? EMPTY_TREE
    const text = await this.#git(r.root, ['diff', '--no-ext-diff', '--no-textconv', '-M', base, detail.hash, '--', ...(entry.from ? [entry.from] : []), file])
    return shapeDiff(file, text, { untracked: false, from: entry.from, large: false })
  }
}

function shapeDiff(file: string, text: string, o: { untracked: boolean; from?: string; large: boolean }): GitDiff {
  const base = { file, ...(o.from ? { from: o.from } : {}), untracked: o.untracked }
  if (o.large || text.length > MAX_DIFF) return { ...base, binary: false, tooLarge: true, hunks: [] }
  const parsed = parseDiff(file, text)
  const lines = parsed.hunks.reduce((n, h) => n + h.lines.length, 0)
  if (lines > MAX_DIFF_LINES) return { ...base, binary: parsed.binary, tooLarge: true, hunks: [] }
  return { ...base, binary: parsed.binary, tooLarge: false, hunks: parsed.hunks.map(({ raw: _raw, ...h }) => h) }
}

/** Git's own words for a failure, without any credentials in a URL. */
function gitMessage(r: Run, what: string): string {
  const text = (r.stderr || r.stdout)
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .filter((l) => l && !/^hint: /.test(l))
    .join('\n')
  return maskText(text || `git ${what} failed (exit ${r.code})`)
}

