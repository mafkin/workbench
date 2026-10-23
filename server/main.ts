// Local Workbench service: config API, live updates and, when built, the UI.
// Listens on loopback only; see guard.ts for who may call it.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { Document, parseDocument } from 'yaml'
import { z } from 'zod'
import {
  ACCENTS,
  AgentProfile,
  CHAT_COLORS,
  chatName,
  chatProgram,
  displayPath,
  entrySlot,
  expandHome,
  FileOp,
  findAgent,
  Drawer,
  drawerSlug,
  entryAt,
  getItem,
  walkItems,
  isReservedAgent,
  ItemAddr,
  Op,
  projectHost,
  SESSION_ID,
  stepEntry,
  stepSlot,
  stepsOf,
  itemBase,
  projectRef,
  type NavItem,
  type Profile,
  type StepItem,
} from '../shared/config-schema.ts'

/** Ops that change an item's steps: the first one on an older project seeds its steps. */
const STEP_OPS = new Set(['addStep', 'updateStep', 'deleteStep', 'moveStep', 'addWorkflow', 'setWorkflow'])
import { agentArgs, claudeAgents } from './agents.ts'
import { Backgrounds } from './backgrounds.ts'
import { Logos } from './logos.ts'
import { Chats, type ChatCommands, type ChatSpec } from './chats.ts'
import { claudeJson, frontmatter, projectKey, readSetup } from './claude-setup.ts'
import type { ClaudeSetup, McpEntry } from '../shared/claude-setup.ts'
import { sessionsIn } from './claude-sessions.ts'
import { applyOps, describeIssue } from './config-ops.ts'
import { ConfigStore, StoreError } from './config-store.ts'
import { Context, drawerContext, mergeContext } from './context.ts'
import { Files, type FilesEvent } from './files.ts'
import { Git, type Repo } from './git.ts'
import { openProgram } from './open-with.ts'
import { Thumbs } from './thumbs.ts'
import { makeGuard } from './guard.ts'
import { LaunchError, openItem, runDetached, runToExit } from './launch.ts'
import { maskText } from './mask.ts'
import { checkServer } from './mcp-check.ts'
import { McpDefaults, setFoldersOff } from './mcp-switch.ts'
import { projectDates } from './project-dates.ts'
import { Servers } from './servers.ts'
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
  /** Claude's managed settings, `/etc/claude-code` (tests point elsewhere). */
  managedDir?: string
  /** How long an MCP check waits for a server. */
  mcpTimeoutMs?: number
  /** How often the active profile's repositories are fetched; 0 for never (tests). */
  gitFetchEveryMs?: number
  /** Where gallery thumbnails are cached; defaults to ~/.cache/workbench/thumbs. */
  thumbsDir?: string
}

const OpsBody = z.object({ rev: z.string(), ops: z.array(Op).min(1) })
const RevBody = z.object({ rev: z.string() })
const ActiveBody = z.object({ profile: z.string() })
const NewProfile = z.object({ id: z.string(), name: z.string().trim().min(1, 'A name is required').max(40), copyFrom: z.string().optional() })
const OpenBody = z.object({ profile: z.string(), rev: z.string(), at: ItemAddr, step: z.int().nonnegative().optional() })
const PathQuery = z.object({ profile: z.string(), path: z.string() })
const NoteSave = z.object({ profile: z.string(), path: z.string(), rev: z.string().nullable(), text: z.string() })
const ProfileQuery = z.object({ profile: z.string() })
const SearchQuery = z.object({ profile: z.string(), q: z.string().default('') })
const FileOpBody = z.object({ profile: z.string(), op: FileOp })
const StopServer = z.object({ profile: z.string(), pid: z.int().positive(), port: z.int().min(1).max(65535) })
const FindQuery = z.object({ profile: z.string(), path: z.string(), q: z.string().default(''), hidden: z.string().optional() })
const UploadQuery = z.object({ profile: z.string(), dir: z.string(), name: z.string() })
const DrawerFolder = z.object({ profile: z.string(), name: Drawer.shape.name })
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
const SetupQuery = z.object({ profile: z.string(), path: z.string().optional() })
// Git: every request names a project (its path as written in the config).
const GitQuery = z.object({ profile: z.string(), path: z.string() })
const GitHunk = z.object({ file: z.string().min(1), id: z.string().regex(/^[0-9a-f]{16}$/, 'Not a hunk') })
const GitFiles = GitQuery.extend({ files: z.array(z.string().min(1)).max(5000).optional(), all: z.boolean().optional(), hunk: GitHunk.optional() })
const GitDiffQuery = GitQuery.extend({ file: z.string().min(1), staged: z.enum(['0', '1']).default('0') })
const GitUndo = GitQuery.extend({ undo: z.string().uuid() })
const GitCommit = GitQuery.extend({ message: z.string().max(100_000), amend: z.boolean().default(false) })
const GitBranch = GitQuery.extend({
  action: z.enum(['switch', 'create', 'rename', 'delete']),
  name: z.string().min(1).max(250),
  to: z.string().min(1).max(250).optional(),
  carry: z.enum(['carry', 'stash']).optional(),
  force: z.boolean().default(false),
})
const GitStash = GitQuery.extend({
  action: z.enum(['push', 'pop', 'apply', 'drop']),
  index: z.int().nonnegative().optional(),
  hash: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  message: z.string().max(500).optional(),
})
const GitRemote = GitQuery.extend({ quiet: z.boolean().default(false), merge: z.boolean().default(false), publish: z.boolean().default(false) })
const GitResolve = GitQuery.extend({ file: z.string().min(1), force: z.boolean().default(false) })
const GitAsk = GitQuery.extend({ files: z.array(z.string().min(1)).min(1).max(200) })
const GitLog = GitQuery.extend({ skip: z.coerce.number().int().nonnegative().default(0) })
const GitShow = GitQuery.extend({ hash: z.string().regex(/^[0-9a-f]{4,64}$/, 'Not a commit'), file: z.string().optional() })
const DocQuery = SetupQuery.extend({ id: z.string() })
const CheckBody = SetupQuery.extend({ id: z.string(), confirm: z.boolean().optional() })
// MCP servers on or off: by their /mcp names, in a folder, or (no path) as the profile's defaults.
const McpSwitch = SetupQuery.extend({ keys: z.array(z.string().min(1)).min(1).max(500), on: z.boolean(), rev: z.string().optional() })

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

export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
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
  const thumbs = new Thumbs(opts.thumbsDir ?? path.join(defaultCacheDir(), 'thumbs'))
  const backgrounds = new Backgrounds(path.join(opts.configDir, 'backgrounds'), store, home)
  const logos = new Logos(path.join(opts.configDir, 'logos'))
  const context = new Context(store, home)
  const servers = new Servers(store, home)
  const stateDir = opts.stateDir ?? path.join(opts.configDir, 'state')
  const chats = new Chats({ stateDir, home, commands: opts.chatCommands, ...opts.chatTiming })
  const mcpDefaults = new McpDefaults({ stateDir, claudeJson: claudeJson(home) })
  await chats.init()
  const git = new Git(store, home, {
    spawn: opts.spawn,
    draft: (cwd, prompt, input) => chats.print(cwd, prompt, input),
    fetchEveryMs: opts.gitFetchEveryMs ?? 10 * 60_000,
    activeProfile: () => store.state().activeProfile ?? null,
  })
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
    context.close()
    git.close()
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

  // Uploads arrive as raw bytes; the route streams them to disk (and counts them) itself.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
  // Thumbnails the gallery made, as bytes (checked again in Thumbs.put).
  app.addContentTypeParser(['image/webp', 'image/png'], { parseAs: 'buffer', bodyLimit: 600 * 1024 }, (_req, body, done) => done(null, body))

  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/state', async () => state())

  app.post<{ Params: { id: string } }>('/api/profiles/:id/ops', async (req) => {
    const { rev, ops } = parse(OpsBody, req.body)
    const before = store.profile(req.params.id).profile
    // An older project without `steps:` gets the tabs it showed as its own on its first step change.
    if (before) {
      for (const op of ops) {
        if (!('at' in op) || !STEP_OPS.has(op.op) || 'seed' in op) continue
        const item = getItem(before, op.at)
        if (item?.type === 'folder' && !item.steps) Object.assign(op, { seed: await stepsFor(req.params.id, before, item) })
      }
    }
    // A chat step's chat is found by its label: a rename moves the chat with it.
    const renames = before
      ? await Promise.all(
          ops.map(async (op) => {
            if (op.op !== 'updateStep') return null
            const project = getItem(before, op.at)
            if (project?.type !== 'folder') return null
            const old = (await stepsFor(req.params.id, before, project))[op.index]
            const ref = projectRef(project)
            return old?.type === 'chat' && old.label !== op.step.label ? { from: stepSlot(ref, old.label), to: stepSlot(ref, String(op.step.label)) } : null
          }),
        )
      : []
    const result = await store.apply(req.params.id, rev, ops)
    for (const r of renames) if (r) chats.moveSlot(req.params.id, r.from, r.to)
    return result
  })

  app.post<{ Params: { id: string } }>('/api/profiles/:id/undo', async (req) => {
    const { rev } = parse(RevBody, req.body)
    return store.undo(req.params.id, rev)
  })

  // Profiles: a new file (blank, or a copy of another with a new name), or one moved to the Trash.
  app.post('/api/profiles', async (req) => {
    const b = parse(NewProfile, req.body)
    let text: string
    if (b.copyFrom) {
      const src = store.profile(b.copyFrom)
      if (!src.profile) throw new StoreError('That profile file is broken', 423)
      const source = store.text(b.copyFrom)
      const doc = parseDocument(source)
      applyOps(doc, [{ op: 'setProfileField', key: 'name', value: b.name }], source)
      text = doc.toString()
    } else {
      const used = store.state().profiles.map((p) => p.profile?.accent)
      const accent = ACCENTS.find((a) => !used.includes(a)) ?? ACCENTS[0]
      text = new Document({ name: b.name, accent, sections: [] }).toString()
    }
    await store.createProfile(b.id, text)
    return { id: b.id }
  })

  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    await store.removeProfile(req.params.id, (file) => runToExit({ command: 'gio', args: ['trash', '--', file] }, opts.spawn))
    return { ok: true }
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
    // A shared entry opens its original.
    const item = entryAt(p.profile, at)?.item
    if (!item) throw new StoreError('No such entry', 404)
    if (step === undefined) {
      await openItem(item, home, opts.spawn)
      return { ok: true }
    }
    const s = item.type === 'folder' ? (await stepsFor(id, p.profile, item))[step] : undefined
    if (!s || item.type !== 'folder') throw new StoreError('No such step', 404)
    const entry = stepEntry(itemBase(p.profile, item), s)
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

  app.get('/api/files/size', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    return files.size(profile, p)
  })

  app.get('/api/files/find', async (req) => {
    const b = parse(FindQuery, req.query)
    return files.find(b.profile, b.path, b.q, b.hidden === '1')
  })

  // A file dropped from the desktop: the body is its bytes, streamed to disk.
  app.post('/api/files/upload', async (req) => {
    const b = parse(UploadQuery, req.query)
    if (!req.body || typeof (req.body as NodeJS.ReadableStream).pipe !== 'function') throw new StoreError('Send the file as application/octet-stream', 415)
    return files.upload(b.profile, b.dir, b.name, req.body as NodeJS.ReadableStream)
  })

  app.post('/api/files/open', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.body)
    await files.open(profile, p)
    return { ok: true }
  })

  // Gallery thumbnails: the cached one, a .blend's own preview, or what the
  // browser should make one from. The browser's thumbnail is stored under the
  // file as it is now; only files of the profile's folders.
  app.get('/api/thumbs', async (req, reply) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    const { real } = await files.resolve(profile, p)
    const got = await thumbs.get(real, (x) => displayPath(x, home))
    if ('data' in got) return reply.type(got.type).header('cache-control', 'no-store').send(got.data)
    return reply.code(404).send({ error: 'No thumbnail yet', ...got })
  })
  app.put('/api/thumbs', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.query)
    if (!Buffer.isBuffer(req.body)) throw new StoreError('Send the thumbnail as image/webp or image/png', 415)
    const { real } = await files.resolve(profile, p)
    await thumbs.put(real, req.body)
    return { ok: true }
  })

  // Open with: the program a file opens in, from the profile's openWith: or the
  // built-in ones (Blender, Godot). The request names only the file.
  app.get('/api/files/open-with', async (req) => {
    const { profile: id, path: p } = parse(PathQuery, req.query)
    const prof = store.profile(id)
    if (!prof.profile) throw new StoreError('The profile file is broken', 423)
    const { real } = await files.resolve(id, p)
    return { label: (await openProgram(prof.profile, real, home))?.label ?? null }
  })
  app.post('/api/files/open-with', async (req) => {
    const { profile: id, path: p } = parse(PathQuery, req.body)
    const prof = store.profile(id)
    if (!prof.profile) throw new StoreError('The profile file is broken', 423)
    const { real } = await files.resolve(id, p)
    const program = await openProgram(prof.profile, real, home)
    if (!program) throw new StoreError('No program is set up for this kind of file', 422)
    try {
      await runDetached({ command: program.command, args: program.args, cwd: program.cwd }, opts.spawn)
    } catch (err) {
      throw new StoreError((err as Error).message, 422)
    }
    return { label: program.label }
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

  // Background pictures: copies in the config folder, from the profile's folders only.
  app.get('/api/backgrounds', async () => backgrounds.list())

  app.get<{ Params: { name: string } }>('/api/backgrounds/:name', async (req, reply) => {
    const pic = await backgrounds.read(req.params.name)
    return reply
      .header('content-type', pic.type)
      .header('content-length', pic.size)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache')
      .send(fs.createReadStream(pic.real))
  })

  app.post('/api/backgrounds', async (req) => {
    const { profile, path: p } = parse(PathQuery, req.body)
    return backgrounds.add(profile, p)
  })

  app.delete<{ Params: { name: string } }>('/api/backgrounds/:name', async (req) => {
    await backgrounds.remove(req.params.name)
    return { ok: true }
  })

  // Drawer logos: 64×64 PNGs the browser made, named by their content.
  app.put('/api/logos', async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new StoreError('A logo must be a PNG', 415)
    return logos.put(req.body)
  })

  app.get<{ Params: { name: string } }>('/api/logos/:name', async (req, reply) => {
    const body = await logos.read(req.params.name)
    return reply.header('content-type', 'image/png').header('x-content-type-options', 'nosniff').header('cache-control', 'max-age=31536000, immutable').send(body)
  })

  // A drawer's shared folder in one click: <notes or home>/drawers/<name>, made
  // here; the UI then sets `folder:` (with Undo). Only the name comes from the request.
  app.post('/api/drawers/folder', async (req) => {
    const b = parse(DrawerFolder, req.body)
    const profile = store.profile(b.profile).profile
    if (!profile) throw new StoreError('The profile is not loaded', 404)
    const folder = `${(profile.notes ?? profile.home ?? '~').replace(/\/+$/, '')}/drawers/${drawerSlug(b.name)}`
    await fsp.mkdir(absPath(folder, home), { recursive: true })
    return { folder }
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
  /** Every claude chat (not the shell) also gets the profile's context folders, once they are set up, and its drawer's shared folders. */
  async function agentFor(id: string, profile: Profile, drawer: number, name: string | undefined, cwd: string, args: string[]) {
    const program = name && isReservedAgent(name) ? chatProgram(name) : 'claude'
    const found = name && !isReservedAgent(name) ? findAgent(profile, name) : null
    if (name && !isReservedAgent(name) && !found) throw new StoreError(`No agent profile named ${name}`, 422)
    if (program === 'shell') return { agent: program, args, agentProfile: null, bypass: false, context: false }
    // The profile's MCP defaults, the first time a chat starts in this folder.
    await mcpDefaults.apply(profile.mcpOff, await projectKey(cwd)).catch((err) => console.error('[mcp defaults]', err))
    const ctx = await context.chatContext(id)
    const start = agentArgs(found ? found[1] : AgentProfile.parse({}), home, cwd, mergeContext(ctx, await drawerContext(profile, drawer, home)))
    return { agent: 'claude' as const, args: [...args, ...start.args], agentProfile: found?.[0] ?? null, bypass: start.bypass, firstPrompt: start.prompt, context: !!ctx }
  }

  /** The drawer holding a project (its folder entry), for its chats' shared folders. */
  const projectDrawer = (profile: Profile, projectPath: string) =>
    walkItems(profile).find((e) => e.item.type === 'folder' && e.item.path === projectPath)?.addr.drawer ?? 0

  /** An item's steps; an older project's include Git only when its folder is in a repository, as its page shows them. */
  async function stepsFor(profileId: string, profile: Profile, item: NavItem): Promise<StepItem[]> {
    if (item.type !== 'folder' || item.steps) return stepsOf(profile, item)
    const repo = item.path ? !!(await git.repo(profileId, item.path).catch(() => null)) : false
    return stepsOf(profile, item, repo)
  }

  app.post('/api/chats', async (req) => {
    const body = parse(ChatStart, req.body)
    const p = store.profile(body.profile)
    if (p.rev !== body.rev || !p.profile) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    // A shared entry starts its original's chat; the chat gets the shared folders of the drawer holding the original.
    const found = entryAt(p.profile, body.at)
    if (!found) throw new StoreError('No such entry', 404)
    const { item } = found
    const drawer = found.addr.drawer ?? 0
    let spec: ChatSpec
    if (item.type === 'chat') {
      const slot = entrySlot(item)
      const cwd = await chatFolder(p.profile, item.path ?? '~', false)
      spec = { profile: body.profile, host: slot, slot, cwd, ...(await agentFor(body.profile, p.profile, drawer, item.agent, cwd, item.args)) }
    } else if (item.type === 'folder' && body.step !== undefined) {
      const step = (await stepsFor(body.profile, p.profile, item))[body.step]
      if (step?.type !== 'chat') throw new StoreError('No such chat step', 404)
      const base = itemBase(p.profile, item)
      const entry = stepEntry(base, step) as typeof step
      const cwd = await chatFolder(p.profile, entry.path ?? base, false)
      const ref = projectRef(item)
      spec = { profile: body.profile, host: projectHost(ref), slot: stepSlot(ref, step.label), cwd, ...(await agentFor(body.profile, p.profile, drawer, step.agent, cwd, step.args)) }
    } else if (item.type === 'folder') {
      const cwd = body.path === undefined ? await chatFolder(p.profile, itemBase(p.profile, item), false) : await chatFolder(p.profile, body.path, true)
      // The New chat menu's pick, else the project's default.
      spec = { profile: body.profile, host: projectHost(projectRef(item)), slot: null, cwd, ...(await agentFor(body.profile, p.profile, drawer, body.agent ?? item.agent, cwd, [])) }
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

  // The summary is also kept in the profile's inbox, when it has one.
  app.post<{ Params: { id: string } }>('/api/chats/:id/handoff', async (req) =>
    chats.handoff(req.params.id, { onSummary: (summary, chat) => context.saveHandoff(chat.profile, chatName(chat), chat.session, summary) }),
  )

  // Context folders: status, setup on request, and files sent to the inbox.
  app.get('/api/context', async (req) => context.status(parse(ProfileQuery, req.query).profile))
  app.post('/api/context/setup', async (req) => context.setup(parse(ProfileQuery, req.body).profile))
  app.post('/api/context/inbox', async (req) => {
    const b = parse(PathQuery, req.body)
    return context.sendToInbox(b.profile, b.path)
  })

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

  // Servers running in the profile's projects (from /proc) and the ones they declare.
  app.get('/api/servers', async (req) => servers.scan(parse(ProfileQuery, req.query).profile))
  app.post('/api/servers/stop', async (req) => {
    const b = parse(StopServer, req.body)
    await servers.stop(b.profile, b.pid, b.port)
    return { ok: true }
  })

  // Git per project: the repository a project of the profile is in. Files,
  // branches, stashes and commits are checked against what git lists; hunks are
  // found again by their hash. A request never carries a patch, a command or flags.
  const repoOf = (q: { profile: string; path: string }) => git.need(q.profile, q.path)
  /** A change, then the status it leaves. */
  const gitDone = async (r: Repo, extra: object = {}) => ({ ...extra, status: await git.status(r) })

  app.get('/api/git/marks', async (req) => git.marks(parse(ProfileQuery, req.query).profile))
  app.get('/api/git/status', async (req) => git.status(await repoOf(parse(GitQuery, req.query))))
  app.get('/api/git/diff', async (req) => {
    const q = parse(GitDiffQuery, req.query)
    return git.diff(await repoOf(q), q.file, q.staged === '1')
  })
  app.post('/api/git/stage', async (req) => {
    const b = parse(GitFiles, req.body)
    const r = await repoOf(b)
    await git.stage(r, b)
    return gitDone(r)
  })
  app.post('/api/git/unstage', async (req) => {
    const b = parse(GitFiles, req.body)
    const r = await repoOf(b)
    await git.unstage(r, b)
    return gitDone(r)
  })
  app.post('/api/git/discard', async (req) => {
    const b = parse(GitFiles, req.body)
    const r = await repoOf(b)
    return gitDone(r, await git.discard(r, b))
  })
  app.post('/api/git/undo', async (req) => {
    const b = parse(GitUndo, req.body)
    const r = await repoOf(b)
    return gitDone(r, await git.undoDiscard(r, b.undo))
  })
  app.post('/api/git/commit', async (req) => {
    const b = parse(GitCommit, req.body)
    const r = await repoOf(b)
    return gitDone(r, { commit: await git.commit(r, b.message, b.amend) })
  })
  app.post('/api/git/draft', async (req) => ({ message: await git.draft(await repoOf(parse(GitQuery, req.body))) }))
  app.get('/api/git/branches', async (req) => git.branches(await repoOf(parse(GitQuery, req.query))))
  app.post('/api/git/branch', async (req) => {
    const b = parse(GitBranch, req.body)
    const r = await repoOf(b)
    if (b.action === 'switch') await git.switchTo(r, b.name, b.carry)
    else if (b.action === 'create') await git.createBranch(r, b.name)
    else if (b.action === 'rename') {
      if (!b.to) throw new StoreError('A new name is required', 400)
      await git.renameBranch(r, b.name, b.to)
    } else await git.deleteBranch(r, b.name, b.force)
    return gitDone(r)
  })
  app.post('/api/git/stash', async (req) => {
    const b = parse(GitStash, req.body)
    const r = await repoOf(b)
    return gitDone(r, await git.stash(r, b))
  })
  app.post('/api/git/fetch', async (req) => {
    const b = parse(GitRemote, req.body)
    const r = await repoOf(b)
    await git.fetch(r, { quiet: b.quiet })
    return gitDone(r)
  })
  app.post('/api/git/pull', async (req) => {
    const b = parse(GitRemote, req.body)
    const r = await repoOf(b)
    return gitDone(r, await git.pull(r, b.merge))
  })
  app.post('/api/git/push', async (req) => {
    const b = parse(GitRemote, req.body)
    const r = await repoOf(b)
    await git.push(r, b.publish)
    return gitDone(r)
  })
  app.post('/api/git/resolve', async (req) => {
    const b = parse(GitResolve, req.body)
    const r = await repoOf(b)
    await git.resolve(r, b.file, b.force)
    return gitDone(r)
  })
  app.post('/api/git/abort', async (req) => {
    const b = parse(GitQuery, req.body)
    const r = await repoOf(b)
    await git.abort(r)
    return gitDone(r)
  })
  app.get('/api/git/log', async (req) => {
    const q = parse(GitLog, req.query)
    return git.log(await repoOf(q), q.skip)
  })
  app.get('/api/git/commit', async (req) => {
    const q = parse(GitShow, req.query)
    const r = await repoOf(q)
    return q.file ? git.commitDiff(r, q.hash, q.file) : git.commitDetail(r, q.hash)
  })
  // Ask claude: a new chat in the project, with a prompt written here from the conflicted files' names.
  app.post('/api/git/ask', async (req) => {
    const b = parse(GitAsk, req.body)
    const r = await repoOf(b)
    const p = store.profile(b.profile)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    const s = await git.status(r)
    const files = b.files.filter((f) => s.conflicts.some((c) => c.path === f))
    if (!files.length) throw new StoreError('None of those files has a conflict', 409)
    const what = s.operation === 'merge' ? (s.operationLabel ?? 'a merge') : 'a stash that was applied'
    const prompt =
      `This repository has merge conflicts from ${what}. Resolve the conflicts in ${files.join(', ')}` +
      ` (paths from the repository's top folder${s.sub ? `; this chat runs in ${s.sub}` : ''}): keep what both sides meant,` +
      ` remove the conflict markers, and say what you chose. Don't stage, commit or abort; I'll mark the files resolved myself.`
    const spec: ChatSpec = { profile: b.profile, host: projectHost(r.project.path), slot: null, cwd: r.dir, ...(await agentFor(b.profile, p.profile, projectDrawer(p.profile, r.project.path), r.project.agent, r.dir, [])) }
    return chats.start({ ...spec, prompt, label: 'Conflicts' })
  })

  // A project card's dates: when its folder was made and last worked on.
  app.get('/api/projects/dates', async (req) => {
    const { profile: id, path: raw } = parse(PathQuery, req.query)
    const p = store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    return projectDates(await chatFolder(p.profile, raw, true))
  })

  // Claude setup: what claude loads, for everywhere or for a folder of the
  // profile. Read-only and masked; a check names a server by id and the command
  // comes from the config files, read again, never from the request.
  async function setupFor(id: string, raw: string | undefined) {
    const p = store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    const folder = raw ? await chatFolder(p.profile, raw, true) : null
    return { folder, profile: p.profile, read: await readSetup({ home, managedDir: opts.managedDir, folder }) }
  }

  /** The setup as the page shows it: everywhere, the profile's defaults are what the switches show. */
  function withDefaults(setup: ClaudeSetup, profile: Profile, folder: string | null): ClaudeSetup {
    const off = new Set(profile.mcpOff ?? [])
    if (!off.size) return setup
    const mcp = setup.mcp.map((m): McpEntry => {
      if (m.state !== 'on' || !off.has(m.key)) return m
      if (folder) return { ...m, note: 'On here, though off by default in this profile' }
      return { ...m, state: 'off', note: 'Off by default: turned off in each project before its first chat' }
    })
    return { ...setup, mcp }
  }

  app.get('/api/claude/setup', async (req) => {
    const q = parse(SetupQuery, req.query)
    const { folder, read, profile } = await setupFor(q.profile, q.path)
    return withDefaults(read.setup, profile, folder)
  })

  // Switch MCP servers off or on the way /mcp does, in one folder; or, with no
  // folder, as the profile's defaults, which also switches every project now.
  // Only names the setup lists (and that can be switched) are accepted.
  app.post('/api/claude/mcp', async (req) => {
    const b = parse(McpSwitch, req.body)
    const { folder, read, profile } = await setupFor(b.profile, b.path)
    for (const key of b.keys) {
      const listed = read.setup.mcp.filter((m) => m.key === key)
      if (!listed.length) throw new StoreError(`No MCP server ${key} here`, 422)
      if (listed.every((m) => m.fixed)) throw new StoreError(`${key}: ${listed[0].fixed}`, 422)
    }
    let rev: string | undefined
    if (folder) {
      await setFoldersOff(claudeJson(home), [await projectKey(folder)], b.keys, !b.on)
    } else {
      if (!b.rev) throw new StoreError('The profile’s rev is needed to change its defaults', 422)
      rev = (await store.apply(b.profile, b.rev, [{ op: 'setMcpOff', names: b.keys, off: !b.on }])).rev
      const keys = new Set<string>()
      for (const { item } of walkItems(profile)) {
        if (item.type !== 'folder' || !item.path) continue
        const dir = await chatFolder(profile, item.path, false)
        if (await fs.promises.stat(dir).then((st) => st.isDirectory(), () => false)) keys.add(await projectKey(dir))
      }
      await setFoldersOff(claudeJson(home), [...keys], b.keys, !b.on)
      if (b.on) await mcpDefaults.forget(b.keys)
      else await mcpDefaults.noteApplied([...keys], b.keys)
    }
    const fresh = await setupFor(b.profile, b.path)
    return { setup: withDefaults(fresh.read.setup, fresh.profile, fresh.folder), ...(rev ? { rev } : {}) }
  })

  app.get('/api/claude/doc', async (req) => {
    const q = parse(DocQuery, req.query)
    const file = (await setupFor(q.profile, q.path)).read.files.get(q.id)
    if (!file) throw new StoreError('Not one of the listed skills, agents or commands', 404)
    const text = await fs.promises.readFile(file, 'utf8').catch(() => {
      throw new StoreError('Cannot read it', 404)
    })
    const { body } = frontmatter(text)
    return { body: maskText(body.length > 200_000 ? `${body.slice(0, 200_000)}\n\n…` : body) }
  })

  app.post('/api/claude/check', async (req) => {
    const b = parse(CheckBody, req.body)
    const { folder, read } = await setupFor(b.profile, b.path)
    const server = read.servers.get(b.id)
    if (!server) throw new StoreError('No such MCP server here', 404)
    const { entry } = server
    if (entry.uncheckable) throw new StoreError(entry.uncheckable, 422)
    if (entry.confirm && !b.confirm) throw new StoreError(`${entry.name} is not approved in claude yet; checking runs it`, 409, { confirm: true })
    return checkServer({ transport: entry.transport, config: server.config, pluginRoot: server.pluginRoot }, { cwd: folder ?? home, timeoutMs: opts.mcpTimeoutMs })
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
    const sendContext = (e: { profile: string }) => res.write(`event: context\ndata: ${JSON.stringify(e)}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    store.on('change', send)
    notes.on('note', sendNote)
    files.on('files', sendFiles)
    chats.on('chats', sendChats)
    context.on('context', sendContext)
    send()
    req.raw.on('close', () => {
      clearInterval(ping)
      store.off('change', send)
      notes.off('note', sendNote)
      files.off('files', sendFiles)
      chats.off('chats', sendChats)
      context.off('context', sendContext)
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

  return { app, store, notes, files, chats, context, git }
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
