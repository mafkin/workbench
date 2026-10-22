// Local Workbench service: config API, live updates and, when built, the UI.
// Listens on loopback only; see guard.ts for who may call it.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { z } from 'zod'
import {
  CHAT_COLORS,
  chatProgram,
  entrySlot,
  expandHome,
  FileOp,
  findAgent,
  getItem,
  isReservedAgent,
  ItemAddr,
  Op,
  projectHost,
  SESSION_ID,
  stepEntry,
  stepSlot,
  stepsOf,
  type Profile,
} from '../shared/config-schema.ts'
import { agentArgs, claudeAgents } from './agents.ts'
import { Chats, type ChatCommands, type ChatSpec } from './chats.ts'
import { sessionsIn } from './claude-sessions.ts'
import { describeIssue } from './config-ops.ts'
import { ConfigStore, StoreError } from './config-store.ts'
import { Files, type FilesEvent } from './files.ts'
import { makeGuard } from './guard.ts'
import { LaunchError, openItem } from './launch.ts'
import { Notes, type NoteEvent } from './notes.ts'
import { absPath, browseRoots, realish, within } from './paths.ts'

export const DEFAULT_PORT = 7420
const DEV_UI_PORT = 7421
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface ServerOptions {
  configDir: string
  port: number
  dev?: boolean
  distDir?: string | null
  home?: string
  spawn?: Parameters<typeof openItem>[2]
  watch?: boolean
  /** Where the chat list is kept; defaults to `state/` in the config folder (tests). */
  stateDir?: string
  /** Programs for chats; tests pass stand-ins. */
  chatCommands?: Partial<ChatCommands>
  /** How quickly a chat that went quiet after working needs you (tests). */
  chatTiming?: { quietMs: number; busyMs: number }
}

const OpsBody = z.object({ rev: z.string(), ops: z.array(Op).min(1) })
const RevBody = z.object({ rev: z.string() })
const ActiveBody = z.object({ profile: z.string() })
const OpenBody = z.object({ profile: z.string(), rev: z.string(), at: ItemAddr, step: z.int().nonnegative().optional() })
const PathQuery = z.object({ profile: z.string(), path: z.string() })
const NoteSave = z.object({ profile: z.string(), path: z.string(), rev: z.string().nullable(), text: z.string() })
const ProfileQuery = z.object({ profile: z.string() })
const SearchQuery = z.object({ profile: z.string(), q: z.string().default('') })
const FileOpBody = z.object({ profile: z.string(), op: FileOp })
const TicketBody = z.object({ profile: z.string(), path: z.string(), folder: z.boolean().optional() })
const ChatStart = z.object({
  profile: z.string(),
  rev: z.string(),
  at: ItemAddr,
  step: z.int().nonnegative().optional(),
  /** claude, shell or an agent profile's name (the New chat menu); else the step's, entry's or project's. */
  agent: z.string().trim().min(1).max(64).optional(),
  path: z.string().optional(),
  resume: z.string().regex(SESSION_ID, 'Not a session id').optional(),
})
const ChatPatch = z.object({
  label: z.string().max(80).nullable().optional(),
  color: z
    .string()
    .refine((c) => CHAT_COLORS.includes(c), 'Not one of the chat colours')
    .nullable()
    .optional(),
  pinned: z.boolean().optional(),
})
const ChatRestart = z.object({ fresh: z.boolean().default(false) })

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new StoreError(describeIssue(result.error), 400)
  return result.data
}

export function defaultConfigDir(): string {
  if (process.env.WORKBENCH_CONFIG_DIR) return process.env.WORKBENCH_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'workbench')
}

export function defaultStateDir(): string {
  if (process.env.WORKBENCH_STATE_DIR) return process.env.WORKBENCH_STATE_DIR
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state')
  return path.join(base, 'workbench')
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export async function buildServer(opts: ServerOptions) {
  const home = opts.home ?? os.homedir()
  const store = new ConfigStore(opts.configDir)
  await store.init({ watch: opts.watch ?? true })
  store.on('error', (err) => console.error('[config]', err))
  const notes = new Notes(store, home)
  const files = new Files(store, home, { spawn: opts.spawn })
  const chats = new Chats({ stateDir: opts.stateDir ?? path.join(opts.configDir, 'state'), home, commands: opts.chatCommands, ...opts.chatTiming })
  await chats.init()
  // A chat's terminal is shell access. Besides the guard, its socket needs this
  // token, new on every start, which only the app can read (through the API).
  const ptyToken = randomBytes(32).toString('hex')
  const state = () => ({ ...store.state(), home })

  const app = Fastify({ logger: false })
  const guard = makeGuard(opts.dev ? [opts.port, DEV_UI_PORT] : [opts.port])

  app.addHook('onRequest', async (req, reply) => {
    // A socket upgrade is checked in its route's preValidation instead: refused
    // here, the upgraded connection would be left open.
    if (req.headers.upgrade && req.url.startsWith('/pty/')) return
    const reason = guard(req.headers, req.url)
    if (reason) return reply.code(403).send({ error: reason })
  })
  app.addHook('onClose', async () => {
    store.close()
    notes.close()
    files.close()
    await chats.shutdown()
  })
  // The token comes as a second subprotocol, so it never appears in a URL or a log;
  // the reply names only `workbench`.
  await app.register(websocket, {
    options: { maxPayload: 1024 * 1024, handleProtocols: (protocols) => (protocols.has('workbench') ? 'workbench' : false) },
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof StoreError) return reply.code(err.status).send({ error: err.message, ...err.data })
    if (err instanceof LaunchError) return reply.code(422).send({ error: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message })
    console.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/state', async () => state())

  app.post<{ Params: { id: string } }>('/api/profiles/:id/ops', async (req) => {
    const { rev, ops } = parse(OpsBody, req.body)
    return store.apply(req.params.id, rev, ops)
  })

  app.post<{ Params: { id: string } }>('/api/profiles/:id/undo', async (req) => {
    const { rev } = parse(RevBody, req.body)
    return store.undo(req.params.id, rev)
  })

  app.post('/api/active', async (req) => {
    await store.setActive(parse(ActiveBody, req.body).profile)
    return { ok: true }
  })

  // Opens an entry, or a project's workflow step, from the config by its address;
  // requests never carry a command.
  app.post('/api/open', async (req) => {
    const { profile: id, rev, at, step } = parse(OpenBody, req.body)
    const p = store.profile(id)
    if (p.rev !== rev || !p.profile) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    const item = getItem(p.profile, at)
    if (!item) throw new StoreError('No such entry', 404)
    if (step === undefined) {
      await openItem(item, home, opts.spawn)
      return { ok: true }
    }
    const s = stepsOf(p.profile, item)[step]
    if (!s || item.type !== 'folder') throw new StoreError('No such step', 404)
    const entry = stepEntry(item.path, s)
    if (entry.type !== 'launch' && entry.type !== 'link') throw new StoreError('This step opens in its tab', 422)
    await openItem(entry, home, opts.spawn)
    return { ok: true }
  })

  app.get<{ Querystring: { path?: string } }>('/api/stat', async (req) => {
    const raw = req.query.path ?? ''
    if (!raw) throw new StoreError('path is required', 400)
    const stat = fs.statSync(expandHome(raw, home), { throwIfNoEntry: false })
    return { exists: !!stat, kind: stat ? (stat.isDirectory() ? 'dir' : 'file') : null }
  })

  // Notes: paths are checked against the profile's notes folder and note entries (see notes.ts).
  app.get('/api/notes/file', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    return notes.read(profile, p)
  })

  // A note may be up to 2 MB; JSON escaping can roughly double that.
  app.post('/api/notes/file', { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const { profile, path: p, rev, text } = parse(NoteSave, req.body)
    return notes.write(profile, p, rev, text)
  })

  app.get('/api/notes/list', async (req) => notes.list(parse(ProfileQuery, req.query).profile))

  app.get('/api/notes/search', async (req) => {
    const { profile, q } = parse(SearchQuery, req.query)
    return notes.search(profile, q)
  })

  app.get('/api/notes/asset', async (req, reply) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    const image = await notes.asset(profile, p)
    return reply
      .header('content-type', image.type)
      .header('content-length', image.size)
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache')
      .send(fs.createReadStream(image.real))
  })

  // Files: paths are confined to the profile's folders (see files.ts and paths.ts).
  app.get('/api/files/list', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    return files.list(profile, p)
  })

  app.get('/api/files/text', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    return files.text(profile, p)
  })

  app.post('/api/files/ticket', async (req) => {
    const { profile, path: p, folder } = parse(TicketBody, req.body)
    return files.ticket(profile, p, { folder })
  })

  app.post('/api/files/op', async (req) => {
    const { profile, op } = parse(FileOpBody, req.body)
    return files.op(profile, op)
  })

  app.post('/api/files/open', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.body)
    await files.open(profile, p)
    return { ok: true }
  })

  // Media and HTML reports for previews. <video>, <audio>, the PDF viewer and iframes
  // cannot send X-Workbench, so they use a ticket the app asked for with it; the Host
  // and Origin checks still apply. A report's scripts run in a sandbox without our
  // origin, so they cannot reach the app or the API.
  app.get<{ Params: { token: string; '*': string } }>('/raw/:token/*', async (req, reply) => {
    const file = await files.rawFile(req.params.token, req.params['*'])
    if (!file) return reply.code(404).send({ error: 'Not found' })
    if (file.type) reply.header('content-type', file.type)
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store')
    const ext = path.extname(file.real).toLowerCase()
    if (ext === '.svg') reply.header('content-security-policy', 'sandbox')
    if (ext === '.html' || ext === '.htm') reply.header('content-security-policy', 'sandbox allow-scripts allow-popups allow-forms')
    return reply.sendFile(path.basename(file.real), path.dirname(file.real), { dotfiles: 'allow', acceptRanges: true })
  })

  // Chats: started from an entry or step in the config, by address; a request
  // never carries a command or arguments.
  async function chatFolder(profile: Profile, raw: string, confine: boolean): Promise<string> {
    const real = await realish(absPath(raw, home))
    if (confine && !(await browseRoots(profile, home)).some((r) => within(real, r.real))) {
      throw new StoreError("Not allowed: outside this profile's folders", 403)
    }
    return real
  }

  app.get('/api/chats', async (req) => chats.list(parse(ProfileQuery, req.query).profile))

  app.get('/api/chats/token', async () => ({ token: ptyToken }))

  /** What a chat's `agent:` starts: the shell, plain claude, or claude with an agent profile's flags. */
  function agentFor(profile: Profile, name: string | undefined, cwd: string, args: string[]) {
    if (!name || isReservedAgent(name)) return { agent: chatProgram(name), args, agentProfile: null, bypass: false }
    const found = findAgent(profile, name)
    if (!found) throw new StoreError(`No agent profile named ${name}`, 422)
    const start = agentArgs(found[1], home, cwd)
    return { agent: 'claude' as const, args: [...args, ...start.args], agentProfile: found[0], bypass: start.bypass, firstPrompt: start.prompt }
  }

  app.post('/api/chats', async (req) => {
    const body = parse(ChatStart, req.body)
    const p = store.profile(body.profile)
    if (p.rev !== body.rev || !p.profile) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    const item = getItem(p.profile, body.at)
    if (!item) throw new StoreError('No such entry', 404)
    let spec: ChatSpec
    if (item.type === 'chat') {
      const slot = entrySlot(item)
      const cwd = await chatFolder(p.profile, item.path ?? '~', false)
      spec = { profile: body.profile, host: slot, slot, cwd, ...agentFor(p.profile, item.agent, cwd, item.args) }
    } else if (item.type === 'folder' && body.step !== undefined) {
      const step = stepsOf(p.profile, item)[body.step]
      if (step?.type !== 'chat') throw new StoreError('No such chat step', 404)
      const entry = stepEntry(item.path, step) as typeof step
      const cwd = await chatFolder(p.profile, entry.path ?? item.path, false)
      spec = { profile: body.profile, host: projectHost(item.path), slot: stepSlot(item.path, step.label), cwd, ...agentFor(p.profile, step.agent, cwd, step.args) }
    } else if (item.type === 'folder') {
      const cwd = body.path === undefined ? await chatFolder(p.profile, item.path, false) : await chatFolder(p.profile, body.path, true)
      // The New chat menu's pick, else the project's default.
      spec = { profile: body.profile, host: projectHost(item.path), slot: null, cwd, ...agentFor(p.profile, body.agent ?? item.agent, cwd, []) }
    } else {
      throw new StoreError('Only projects and chat entries have chats', 422)
    }
    if (body.resume) spec.resume = body.resume
    // A step or an entry has one chat: opening it again returns it, and resuming
    // an earlier session there replaces it once it has stopped.
    const existing = spec.slot ? chats.inSlot(body.profile, spec.slot) : undefined
    if (existing && !body.resume) return existing
    if (existing) {
      if (existing.state === 'running') throw new StoreError('Stop this chat first', 409)
      await chats.close(existing.id)
    }
    return chats.start(spec)
  })

  app.patch<{ Params: { id: string } }>('/api/chats/:id', async (req) => chats.update(req.params.id, parse(ChatPatch, req.body)))

  app.post<{ Params: { id: string } }>('/api/chats/:id/start', async (req) => chats.restart(req.params.id, parse(ChatRestart, req.body ?? {})))

  app.post<{ Params: { id: string } }>('/api/chats/:id/seen', async (req) => {
    chats.seen(req.params.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/chats/:id/handoff', async (req) => chats.handoff(req.params.id))

  app.delete<{ Params: { id: string } }>('/api/chats/:id', async (req) => {
    await chats.close(req.params.id)
    return { ok: true }
  })

  // Claude Code agents an agent profile can name (the editor's suggestions).
  app.get('/api/chats/claude-agents', async (req) => {
    const { profile: id, path: raw } = parse(PathQuery, req.query)
    const p = store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    return claudeAgents(home, await chatFolder(p.profile, raw, true))
  })

  app.get('/api/chats/history', async (req) => {
    const { profile: id, path: raw } = parse(PathQuery, req.query)
    const p = store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    return sessionsIn(await chatFolder(p.profile, raw, true), home)
  })

  // A chat's terminal. Frames to the view: `r` + the whole screen, `o` + output.
  // From the view: `i` + typed input, `s` + "cols,rows", `f` + 1 or 0 (window focus).
  app.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
    '/pty/:id',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const reason = guard(req.headers, req.url)
        if (reason) return reply.code(403).send({ error: reason })
        const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
        const given = offered.find((s) => s.startsWith('wb.'))?.slice(3) ?? ''
        if (!sameSecret(given, ptyToken)) return reply.code(403).send({ error: 'Missing or wrong chat token' })
        if (!chats.get(req.params.id)) return reply.code(404).send({ error: 'No such chat' })
      },
    },
    (socket, req) => {
      const id = req.params.id
      chats.resize(id, Number(req.query.cols), Number(req.query.rows))
      const view = chats.attach(id, {
        send: (frame) => {
          if (socket.readyState === socket.OPEN) socket.send(frame)
        },
        close: () => socket.close(4404, 'Chat closed'),
      })
      socket.on('message', (raw) => {
        const msg = raw.toString()
        const rest = msg.slice(1)
        if (msg[0] === 'i') chats.write(id, rest)
        else if (msg[0] === 's') {
          const [cols, rows] = rest.split(',').map(Number)
          chats.resize(id, cols, rows)
        } else if (msg[0] === 'f') view.focus(rest === '1')
      })
      socket.on('close', () => view.detach())
    },
  )

  // Server-sent events: the full state after every change, changes to open notes, to listed folders and to chats.
  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = () => res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`)
    const sendNote = (e: NoteEvent) => res.write(`event: note\ndata: ${JSON.stringify(e)}\n\n`)
    const sendFiles = (e: FilesEvent) => res.write(`event: files\ndata: ${JSON.stringify(e)}\n\n`)
    const sendChats = (e: { profile: string }) => res.write(`event: chats\ndata: ${JSON.stringify(e)}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    store.on('change', send)
    notes.on('note', sendNote)
    files.on('files', sendFiles)
    chats.on('chats', sendChats)
    send()
    req.raw.on('close', () => {
      clearInterval(ping)
      store.off('change', send)
      notes.off('note', sendNote)
      files.off('files', sendFiles)
      chats.off('chats', sendChats)
    })
  })

  const distDir = opts.distDir === undefined ? path.join(ROOT, 'dist') : opts.distDir
  const serveUi = !!distDir && fs.existsSync(path.join(distDir, 'index.html'))
  // Registered even without a UI to serve: /raw uses reply.sendFile, which handles Range requests.
  await app.register(fastifyStatic, serveUi ? { root: distDir } : { root: ROOT, serve: false })
  if (serveUi) {
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/pty/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'Not found' })
    })
  }

  return { app, store, notes, files, chats }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const portArg = args.indexOf('--port')
  const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.WORKBENCH_PORT || DEFAULT_PORT)
  const dev = args.includes('--dev')
  const configDir = defaultConfigDir()
  const { app } = await buildServer({ configDir, port, dev, distDir: dev ? null : undefined, stateDir: defaultStateDir() })
  await app.listen({ host: '127.0.0.1', port })
  console.log(`Workbench service on http://127.0.0.1:${port}/ (config: ${configDir})`)
  const stop = () => app.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
