// Agent chats: claude (or the login shell) in a pseudo-terminal, kept by the
// service so a chat survives reloads and a closed window. Each running chat has
// a headless terminal holding its screen and scrollback, which a reconnecting
// view gets back exactly. The list of chats is saved; after a restart of the
// service the chats come back stopped, to be resumed by hand.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import serialize from '@xterm/addon-serialize'
import headless from '@xterm/headless'
import type { IPty } from 'node-pty'
import { displayPath, SESSION_ID, type Agent, type Chat } from '../shared/config-schema.ts'
import { countPrompts, sessionFile } from './claude-sessions.ts'
import { StoreError } from './config-store.ts'
import { writeAtomic } from './fs-util.ts'

export interface ChatCommands {
  claude: string
  shell: string
}

export interface ChatsOptions {
  stateDir: string
  home: string
  /** Programs to run; tests pass stand-ins. Defaults: claude from PATH, $SHELL. */
  commands?: Partial<ChatCommands>
  /** Output stopping this long after `busyMs` of work asks for attention. */
  quietMs?: number
  busyMs?: number
  /** The SessionStart hook that tells a chat about /clear and /resume; false for none. */
  sessionHook?: string | false
}

const SESSION_HOOK = fileURLToPath(new URL('./session-hook.mjs', import.meta.url))

export interface ChatSpec {
  profile: string
  host: string
  slot: string | null
  agent: Agent
  /** Absolute, real path. */
  cwd: string
  /** From the config only. */
  args: string[]
  /** A Claude session to continue (from History). */
  resume?: string
  /** First prompt for claude (summarize and continue). */
  prompt?: string
  label?: string | null
  color?: string | null
  /** The agent profile its flags (in `args`) came from. */
  agentProfile?: string | null
  bypass?: boolean
  /** The agent profile's first prompt: sent on a new session, not on a resume. */
  firstPrompt?: string
  /** `args` carry the profile's context folders. */
  context?: boolean
}

/** Receives frames for one view: `r` + the whole screen (reset), `o` + output. */
export interface ChatSink {
  send(frame: string): void
  close(): void
}

interface View {
  sink: ChatSink
  focused: boolean
  ready: boolean
  pending: string[]
}

interface Live {
  proc: IPty | null
  term: headless.Terminal
  ser: serialize.SerializeAddon
  burstStart: number | null
  lastOutput: number
  quiet?: ReturnType<typeof setTimeout>
}

interface Meta {
  args: string[]
  firstPrompt?: string
  dir: string
  cols: number
  rows: number
}

type Saved = Omit<Chat, 'state' | 'exitCode' | 'attention'> & { args: string[]; firstPrompt?: string; dir: string }

const HANDOFF_PROMPT =
  'Write a handoff summary of this conversation for a fresh session that will continue the work: the goal, ' +
  'what has been done, the current state (files changed, decisions made), open problems and the next steps. ' +
  'Be concise and specific. Use Markdown. Do not use any tools.'

// Set by a running claude for the programs it starts; a chat started from a
// service that was itself started inside claude must not inherit them.
const NESTED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID']

const cleanTitle = (t: string) => t.replace(/^[^\p{L}\p{N}]+/u, '').trim() || null

// node-pty is built on install (gcc, make, python3). It loads with the first
// chat, so a failed build leaves the rest of the app working.
let ptyModule: Promise<typeof import('node-pty')> | null = null
async function loadPty() {
  ptyModule ??= import('node-pty')
  try {
    return await ptyModule
  } catch (err) {
    ptyModule = null
    throw new StoreError(`Chats need node-pty, which did not load (${(err as Error).message}); run npm install, which builds it with gcc, make and python3`, 500)
  }
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A program by name on PATH, then in the places claude's installers use. */
export function findProgram(name: string, home: string, envPath = process.env.PATH ?? ''): string | null {
  if (name.includes('/')) return executable(name) ? name : null
  const dirs = [...envPath.split(':').filter(Boolean), path.join(home, '.local/bin'), path.join(home, '.claude/local'), '/usr/local/bin', '/usr/bin']
  for (const dir of dirs) {
    const file = path.join(dir, name)
    if (executable(file)) return file
  }
  return null
}

export class Chats extends EventEmitter {
  #file: string
  #home: string
  #commands: Partial<ChatCommands>
  #quietMs: number
  #busyMs: number
  #chats = new Map<string, Chat>()
  #meta = new Map<string, Meta>()
  #live = new Map<string, Live>()
  #views = new Map<string, Set<View>>()
  #handing = new Set<string>()
  #emitting = new Set<string>()
  #saveTimer?: ReturnType<typeof setTimeout>
  #saving: Promise<void> = Promise.resolve()
  #hook: string | false
  #hookDir: string
  #hookWatch: fs.FSWatcher | null = null

  constructor(opts: ChatsOptions) {
    super()
    this.#file = path.join(opts.stateDir, 'chats.json')
    this.#home = opts.home
    this.#commands = opts.commands ?? {}
    this.#quietMs = opts.quietMs ?? 3000
    this.#busyMs = opts.busyMs ?? 3000
    this.#hook = opts.sessionHook ?? SESSION_HOOK
    this.#hookDir = path.join(opts.stateDir, 'sessions')
  }

  /**
   * claude flags that make it report its session on start, /clear and /resume;
   * hooks from --settings run alongside your own.
   */
  #hookArgs(): string[] {
    if (!this.#hook || !fs.existsSync(this.#hook)) return []
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(this.#hook)}`
    return ['--settings', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } })]
  }

  /** The hook wrote a chat's session: follow it when it moved on (/clear, /resume). */
  async #heard(file: string) {
    const id = file.replace(/\.json$/, '')
    const chat = this.#chats.get(id)
    if (!chat || chat.agent !== 'claude') return
    const data = await fsp
      .readFile(path.join(this.#hookDir, file), 'utf8')
      .then((t) => JSON.parse(t) as { session?: string }, () => null)
    if (!data?.session || !SESSION_ID.test(data.session) || data.session === chat.session) return
    chat.session = data.session
    chat.messages = 0
    this.#changed(chat)
    void this.#count(chat)
  }

  async init() {
    await fsp.mkdir(this.#hookDir, { recursive: true })
    try {
      this.#hookWatch = fs.watch(this.#hookDir, (_e, name) => {
        if (name?.endsWith('.json')) void this.#heard(name)
      })
    } catch {
      // Without the watch, chats just do not follow /clear.
    }
    let saved: Saved[] = []
    try {
      const data = JSON.parse(await fsp.readFile(this.#file, 'utf8'))
      if (Array.isArray(data?.chats)) saved = data.chats
    } catch {
      // first start, or an unreadable file: no chats
    }
    for (const s of saved) {
      if (typeof s?.id !== 'string' || typeof s.dir !== 'string') continue
      const { args, dir, firstPrompt, ...chat } = s
      // Lists saved before agent profiles or context have no agentProfile, bypass or context.
      this.#chats.set(s.id, {
        ...chat,
        agentProfile: chat.agentProfile ?? null,
        bypass: chat.bypass ?? false,
        context: chat.context ?? false,
        state: 'stopped',
        exitCode: null,
        attention: false,
      })
      this.#meta.set(s.id, {
        args: Array.isArray(args) ? args.map(String) : [],
        firstPrompt: typeof firstPrompt === 'string' ? firstPrompt : undefined,
        dir,
        cols: 100,
        rows: 30,
      })
    }
  }

  list(profile: string): Chat[] {
    return [...this.#chats.values()].filter((c) => c.profile === profile).map((c) => ({ ...c }))
  }

  get(id: string): Chat | undefined {
    const c = this.#chats.get(id)
    return c && { ...c }
  }

  /** The chat in a slot (a chat step or chat entry), if it has one. */
  inSlot(profile: string, slot: string): Chat | undefined {
    return this.list(profile).find((c) => c.slot === slot)
  }

  async start(spec: ChatSpec): Promise<Chat> {
    const id = randomUUID()
    const chat: Chat = {
      id,
      profile: spec.profile,
      host: spec.host,
      slot: spec.slot,
      agent: spec.agent,
      agentProfile: spec.agentProfile ?? null,
      bypass: spec.bypass ?? false,
      cwd: displayPath(spec.cwd, this.#home),
      label: spec.label ?? null,
      title: null,
      color: spec.color ?? null,
      pinned: false,
      session: spec.agent === 'claude' ? (spec.resume ?? randomUUID()) : null,
      state: 'stopped',
      exitCode: null,
      attention: false,
      messages: 0,
      createdAt: Date.now(),
      context: spec.context ?? false,
    }
    this.#meta.set(id, { args: spec.args, firstPrompt: spec.firstPrompt, dir: spec.cwd, cols: 100, rows: 30 })
    try {
      // A resumed session goes on where it was; a new one gets the profile's first prompt.
      await this.#spawn(chat, { resume: !!spec.resume, prompt: spec.resume ? undefined : (spec.prompt ?? spec.firstPrompt) })
    } catch (err) {
      this.#meta.delete(id)
      throw err
    }
    this.#chats.set(id, chat)
    this.#changed(chat)
    if (spec.resume) void this.#count(chat)
    return { ...chat }
  }

  /** Start a stopped or exited chat again: claude resumes its session, or with `fresh` starts a new one. */
  async restart(id: string, { fresh }: { fresh: boolean }): Promise<Chat> {
    const chat = this.#need(id)
    if (chat.state === 'running') throw new StoreError('This chat is running', 409)
    let resume = false
    let prompt: string | undefined
    if (chat.agent === 'claude') {
      if (fresh || !chat.session) {
        chat.session = randomUUID()
        chat.messages = 0
        prompt = this.#meta.get(id)!.firstPrompt
      } else {
        // A session nobody typed in has no transcript, and claude cannot resume it.
        resume = fs.existsSync(sessionFile(this.#home, this.#meta.get(id)!.dir, chat.session))
      }
    }
    await this.#spawn(chat, { resume, prompt })
    this.#changed(chat)
    if (resume) void this.#count(chat)
    return { ...chat }
  }

  /** A chat step was renamed: its chat goes with it. */
  moveSlot(profile: string, from: string, to: string) {
    for (const chat of this.#chats.values()) {
      if (chat.profile !== profile || chat.slot !== from) continue
      chat.slot = to
      this.#changed(chat)
    }
  }

  async update(id: string, patch: { label?: string | null; color?: string | null; pinned?: boolean }) {
    const chat = this.#need(id)
    if (patch.label !== undefined) chat.label = patch.label?.trim() || null
    if (patch.color !== undefined) chat.color = patch.color
    if (patch.pinned !== undefined) chat.pinned = patch.pinned
    this.#changed(chat)
    return { ...chat }
  }

  seen(id: string) {
    const chat = this.#need(id)
    if (!chat.attention) return
    chat.attention = false
    this.#changed(chat, false)
  }

  write(id: string, data: string) {
    this.#live.get(id)?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const meta = this.#meta.get(id)
    if (!meta || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 500) return
    if (meta.cols === cols && meta.rows === rows) return
    meta.cols = cols
    meta.rows = rows
    const live = this.#live.get(id)
    if (!live) return
    live.term.resize(cols, rows)
    try {
      live.proc?.resize(cols, rows)
    } catch {
      // the program just ended
    }
  }

  /** A view of the chat: gets the screen, then output, until it detaches. */
  attach(id: string, sink: ChatSink) {
    this.#need(id)
    const view: View = { sink, focused: false, ready: false, pending: [] }
    let views = this.#views.get(id)
    if (!views) this.#views.set(id, (views = new Set()))
    views.add(view)
    this.#reset(id, view)
    return {
      detach: () => {
        this.#views.get(id)?.delete(view)
      },
      /** A view in a focused window is being looked at, so the chat needs nobody's attention. */
      focus: (on: boolean) => {
        view.focused = on
        if (on) this.seen(id)
      },
    }
  }

  /** The screen and scrollback as escape sequences; empty when the chat has never run since the service started. */
  screen(id: string): string {
    return this.#live.get(id)?.ser.serialize() ?? ''
  }

  /** The screen as plain text (tests). */
  text(id: string): string {
    const live = this.#live.get(id)
    if (!live) return ''
    const buf = live.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (!line) continue
      const s = line.translateToString(true)
      if (line.isWrapped && lines.length) lines[lines.length - 1] += s
      else lines.push(s)
    }
    return lines.join('\n').trimEnd()
  }

  pid(id: string): number | undefined {
    return this.#live.get(id)?.proc?.pid
  }

  /**
   * A one-off answer from claude (a commit message): `claude -p` in `cwd` with
   * `input` on stdin, no tools, and no session kept, so it stays out of History.
   */
  print(cwd: string, prompt: string, input: string, timeoutMs = 90_000): Promise<string> {
    const cmd = this.#program('claude')
    return new Promise((resolve, reject) => {
      const child = execFile(
        cmd,
        ['-p', prompt, '--no-session-persistence', '--tools', ''],
        { cwd, env: this.#env(cmd), timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(new StoreError(`claude could not answer: ${err.killed ? 'it took too long' : err.message}`, 502)) : resolve(stdout)),
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }

  /**
   * Summarize and continue: claude writes a handoff of the session in the
   * background (a fork, so the session itself is untouched), and a new chat
   * starts with it. A chat step or entry moves to the new chat; a tab started
   * with New chat stays open beside it. `onSummary` gets the summary first
   * (the service keeps a copy in the inbox); its failure does not stop the handoff.
   */
  async handoff(id: string, { onSummary }: { onSummary?: (summary: string, chat: Chat) => Promise<unknown> } = {}): Promise<Chat> {
    const chat = this.#need(id)
    if (chat.agent !== 'claude' || !chat.session) throw new StoreError('Only a Claude chat can be summarized', 422)
    if (this.#handing.has(id)) throw new StoreError('Already summarizing this chat', 409)
    const meta = this.#meta.get(id)!
    if (!fs.existsSync(sessionFile(this.#home, meta.dir, chat.session))) throw new StoreError('Nothing to summarize yet', 422)
    this.#handing.add(id)
    try {
      const cmd = this.#program('claude')
      const summary = await new Promise<string>((resolve, reject) =>
        execFile(
          cmd,
          [...meta.args, '-p', '--resume', chat.session!, '--fork-session', HANDOFF_PROMPT],
          { cwd: meta.dir, env: this.#env(cmd), timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout) => (err ? reject(new StoreError(`claude could not summarize: ${err.message}`, 502)) : resolve(stdout.trim())),
        ),
      )
      if (!summary) throw new StoreError('claude gave no summary', 502)
      await onSummary?.(summary, { ...chat }).catch((err) => console.error('[chats] keeping the handoff:', err))
      const next = await this.start({
        profile: chat.profile,
        host: chat.host,
        slot: chat.slot,
        agent: 'claude',
        cwd: meta.dir,
        args: meta.args,
        prompt: `Continue from this handoff of an earlier session (${chat.session}):\n\n${summary}`,
        label: chat.label,
        color: chat.color,
        agentProfile: chat.agentProfile,
        bypass: chat.bypass,
        firstPrompt: meta.firstPrompt,
        context: chat.context,
      })
      if (chat.slot) await this.close(id)
      return next
    } finally {
      this.#handing.delete(id)
    }
  }

  /** End the program (claude keeps its session for History) and forget the chat. */
  async close(id: string) {
    const chat = this.#need(id)
    const live = this.#live.get(id)
    if (live) this.#end(live)
    this.#live.delete(id)
    for (const v of this.#views.get(id) ?? []) v.sink.close()
    this.#views.delete(id)
    this.#chats.delete(id)
    this.#meta.delete(id)
    await fsp.rm(path.join(this.#hookDir, `${id}.json`), { force: true })
    this.#changed(chat)
  }

  /** Stop every program and save the list (the service is closing). */
  async shutdown() {
    this.#hookWatch?.close()
    for (const live of this.#live.values()) this.#end(live)
    this.#live.clear()
    clearTimeout(this.#saveTimer)
    await this.#save()
  }

  #need(id: string): Chat {
    const chat = this.#chats.get(id)
    if (!chat) throw new StoreError('No such chat', 404)
    return chat
  }

  #program(agent: Agent): string {
    const wanted = this.#commands[agent === 'claude' ? 'claude' : 'shell']
    if (wanted) return wanted
    if (agent === 'shell') return findProgram(process.env.SHELL || 'bash', this.#home) ?? '/bin/bash'
    const found = findProgram('claude', this.#home)
    if (!found) throw new StoreError('claude was not found on PATH, in ~/.local/bin or in ~/.claude/local', 422)
    return found
  }

  #env(cmd: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: this.#home }
    for (const key of NESTED_ENV) delete env[key]
    // A desktop launcher's PATH may lack ~/.local/bin, where claude usually lives.
    const dirs = (env.PATH ?? '').split(':').filter(Boolean)
    for (const d of [path.dirname(cmd), path.join(this.#home, '.local/bin')]) if (path.isAbsolute(d) && !dirs.includes(d)) dirs.push(d)
    env.PATH = dirs.join(':')
    return env
  }

  async #spawn(chat: Chat, { resume, prompt }: { resume: boolean; prompt?: string }) {
    const pty = await loadPty()
    const meta = this.#meta.get(chat.id)!
    if (!fs.statSync(meta.dir, { throwIfNoEntry: false })?.isDirectory()) throw new StoreError(`The folder ${chat.cwd} does not exist`, 422)
    const cmd = this.#program(chat.agent)
    const argv =
      chat.agent === 'claude'
        ? [...meta.args, resume ? '--resume' : '--session-id', chat.session!, ...this.#hookArgs(), ...(prompt ? [prompt] : [])]
        : ['-l', ...meta.args]
    const term = new headless.Terminal({ cols: meta.cols, rows: meta.rows, scrollback: 5000, allowProposedApi: true })
    const ser = new serialize.SerializeAddon()
    term.loadAddon(ser)
    let proc: IPty
    try {
      // The session hook reports to this chat's file.
      const env = { ...this.#env(cmd), WORKBENCH_CHAT: chat.id, WORKBENCH_HOOK_DIR: this.#hookDir }
      proc = pty.spawn(cmd, argv, { name: 'xterm-256color', cols: meta.cols, rows: meta.rows, cwd: meta.dir, env })
    } catch (err) {
      term.dispose()
      throw new StoreError(`Could not start ${path.basename(cmd)}: ${(err as Error).message}`, 422)
    }
    const old = this.#live.get(chat.id)
    if (old) old.term.dispose()
    const live: Live = { proc, term, ser, burstStart: null, lastOutput: 0 }
    this.#live.set(chat.id, live)
    chat.state = 'running'
    chat.exitCode = null
    chat.attention = false

    term.onTitleChange((t) => {
      const title = cleanTitle(t)
      if (title === chat.title) return
      chat.title = title
      this.#changed(chat)
    })
    term.onBell(() => this.#flag(chat))
    proc.onData((data) => {
      if (this.#live.get(chat.id) !== live) return
      term.write(data)
      for (const v of this.#views.get(chat.id) ?? []) {
        if (v.ready) v.sink.send(`o${data}`)
        else v.pending.push(`o${data}`)
      }
      this.#activity(chat, live)
    })
    proc.onExit(({ exitCode }) => {
      if (this.#live.get(chat.id) !== live) return
      live.proc = null
      clearTimeout(live.quiet)
      chat.state = 'exited'
      chat.exitCode = exitCode
      this.#changed(chat)
    })
    // Views already open on this chat start over with the new program.
    for (const v of this.#views.get(chat.id) ?? []) this.#reset(chat.id, v)
  }

  /** Send a view the whole screen once the terminal has taken in everything written so far. */
  #reset(id: string, view: View) {
    view.ready = false
    view.pending = []
    const live = this.#live.get(id)
    if (!live) {
      view.ready = true
      view.sink.send('r')
      return
    }
    live.term.write('', () => {
      if (this.#live.get(id) !== live) return
      view.sink.send(`r${live.ser.serialize()}`)
      for (const f of view.pending) view.sink.send(f)
      view.pending = []
      view.ready = true
    })
  }

  // A burst of output that lasted at least busyMs and then stopped for quietMs:
  // claude finished a turn or is asking for permission.
  #activity(chat: Chat, live: Live) {
    const now = Date.now()
    if (live.burstStart === null) live.burstStart = now
    live.lastOutput = now
    clearTimeout(live.quiet)
    live.quiet = setTimeout(() => {
      const worked = live.burstStart !== null && live.lastOutput - live.burstStart >= this.#busyMs
      live.burstStart = null
      if (worked) this.#flag(chat)
    }, this.#quietMs)
  }

  #flag(chat: Chat) {
    if (!this.#chats.has(chat.id)) return
    if ([...(this.#views.get(chat.id) ?? [])].some((v) => v.focused)) return
    if (chat.attention) return
    chat.attention = true
    this.#changed(chat, false)
    void this.#count(chat)
  }

  // Runs in the background (`void`), so it must never reject.
  async #count(chat: Chat) {
    const meta = this.#meta.get(chat.id)
    if (chat.agent !== 'claude' || !chat.session || !meta) return
    const n = await countPrompts(sessionFile(this.#home, meta.dir, chat.session)).catch(() => chat.messages)
    if (n === chat.messages || !this.#chats.has(chat.id)) return
    chat.messages = n
    this.#changed(chat)
  }

  #end(live: Live) {
    clearTimeout(live.quiet)
    try {
      live.proc?.kill()
    } catch {
      // already gone
    }
    live.proc = null
    live.term.dispose()
  }

  #changed(chat: Chat, save = true) {
    if (save) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = setTimeout(() => void this.#save().catch((err) => console.error('[chats]', err)), 100)
    }
    if (this.#emitting.has(chat.profile)) return
    this.#emitting.add(chat.profile)
    setImmediate(() => {
      this.#emitting.delete(chat.profile)
      this.emit('chats', { profile: chat.profile })
    })
  }

  /** Saves run one after another: two at once would share the temp file. Each writes the list as it is then. */
  #save(): Promise<void> {
    const run = this.#saving.then(() => this.#write())
    this.#saving = run.catch(() => {})
    return run
  }

  async #write() {
    const chats: Saved[] = [...this.#chats.values()].map(({ state: _s, exitCode: _e, attention: _a, ...c }) => {
      const meta = this.#meta.get(c.id)!
      return { ...c, args: meta.args, firstPrompt: meta.firstPrompt, dir: meta.dir }
    })
    await fsp.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    await writeAtomic(this.#file, `${JSON.stringify({ chats }, null, 2)}\n`, 0o600)
  }
}
