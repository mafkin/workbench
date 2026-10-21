// Local Workbench service: config API, live updates and, when built, the UI.
// Listens on loopback only; see guard.ts for who may call it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { z } from 'zod'
import { expandHome, FileOp, getItem, ItemAddr, Op } from '../shared/config-schema.ts'
import { describeIssue } from './config-ops.ts'
import { ConfigStore, StoreError } from './config-store.ts'
import { Files, type FilesEvent } from './files.ts'
import { makeGuard } from './guard.ts'
import { LaunchError, openItem } from './launch.ts'
import { Notes, type NoteEvent } from './notes.ts'

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
}

const OpsBody = z.object({ rev: z.string(), ops: z.array(Op).min(1) })
const RevBody = z.object({ rev: z.string() })
const ActiveBody = z.object({ profile: z.string() })
const OpenBody = z.object({ profile: z.string(), rev: z.string(), at: ItemAddr })
const PathQuery = z.object({ profile: z.string(), path: z.string() })
const NoteSave = z.object({ profile: z.string(), path: z.string(), rev: z.string().nullable(), text: z.string() })
const ProfileQuery = z.object({ profile: z.string() })
const SearchQuery = z.object({ profile: z.string(), q: z.string().default('') })
const FileOpBody = z.object({ profile: z.string(), op: FileOp })

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

export async function buildServer(opts: ServerOptions) {
  const home = opts.home ?? os.homedir()
  const store = new ConfigStore(opts.configDir)
  await store.init({ watch: opts.watch ?? true })
  store.on('error', (err) => console.error('[config]', err))
  const notes = new Notes(store, home)
  const files = new Files(store, home, { spawn: opts.spawn })
  const state = () => ({ ...store.state(), home })

  const app = Fastify({ logger: false })
  const guard = makeGuard(opts.dev ? [opts.port, DEV_UI_PORT] : [opts.port])

  app.addHook('onRequest', async (req, reply) => {
    const reason = guard(req.headers, req.url)
    if (reason) return reply.code(403).send({ error: reason })
  })
  app.addHook('onClose', async () => {
    store.close()
    notes.close()
    files.close()
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

  // Opens an entry from the config by its address; requests never carry a command.
  app.post('/api/open', async (req) => {
    const { profile: id, rev, at } = parse(OpenBody, req.body)
    const p = store.profile(id)
    if (p.rev !== rev || !p.profile) throw new StoreError('The profile changed since it was loaded; reloaded', 409)
    const item = getItem(p.profile, at)
    if (!item) throw new StoreError('No such entry', 404)
    await openItem(item, home, opts.spawn)
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
    const { profile, path: p } = parse(PathQuery, req.body)
    return files.ticket(profile, p)
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

  // Media for previews. <video>, <audio> and the PDF viewer cannot send X-Workbench,
  // so they use a ticket the app asked for with it; the Host and Origin checks still apply.
  app.get<{ Params: { token: string } }>('/raw/:token/:name', (req, reply) => {
    const file = files.raw(req.params.token)
    if (!file) return reply.code(404).send({ error: 'Not found' })
    reply.header('content-type', file.type).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store')
    if (file.type === 'image/svg+xml') reply.header('content-security-policy', 'sandbox')
    return reply.sendFile(path.basename(file.real), path.dirname(file.real), { dotfiles: 'allow', acceptRanges: true })
  })

  // Server-sent events: the full state after every change, changes to open notes, and to listed folders.
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
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    store.on('change', send)
    notes.on('note', sendNote)
    files.on('files', sendFiles)
    send()
    req.raw.on('close', () => {
      clearInterval(ping)
      store.off('change', send)
      notes.off('note', sendNote)
      files.off('files', sendFiles)
    })
  })

  const distDir = opts.distDir === undefined ? path.join(ROOT, 'dist') : opts.distDir
  const serveUi = !!distDir && fs.existsSync(path.join(distDir, 'index.html'))
  // Registered even without a UI to serve: /raw uses reply.sendFile, which handles Range requests.
  await app.register(fastifyStatic, serveUi ? { root: distDir } : { root: ROOT, serve: false })
  if (serveUi) {
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'Not found' })
    })
  }

  return { app, store, notes, files }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const portArg = args.indexOf('--port')
  const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.WORKBENCH_PORT || DEFAULT_PORT)
  const dev = args.includes('--dev')
  const configDir = defaultConfigDir()
  const { app } = await buildServer({ configDir, port, dev, distDir: dev ? null : undefined })
  await app.listen({ host: '127.0.0.1', port })
  console.log(`Workbench service on http://127.0.0.1:${port}/ (config: ${configDir})`)
  const stop = () => app.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
