// Local Workbench service: config API, live updates and, when built, the UI.
// Listens on loopback only; see guard.ts for who may call it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { z } from 'zod'
import { expandHome, getItem, ItemAddr, Op } from '../shared/config-schema.ts'
import { describeIssue } from './config-ops.ts'
import { ConfigStore, StoreError } from './config-store.ts'
import { makeGuard } from './guard.ts'
import { LaunchError, openItem } from './launch.ts'

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

  const app = Fastify({ logger: false })
  const guard = makeGuard(opts.dev ? [opts.port, DEV_UI_PORT] : [opts.port])

  app.addHook('onRequest', async (req, reply) => {
    const reason = guard(req.headers, req.url)
    if (reason) return reply.code(403).send({ error: reason })
  })
  app.addHook('onClose', async () => store.close())

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof StoreError) return reply.code(err.status).send({ error: err.message })
    if (err instanceof LaunchError) return reply.code(422).send({ error: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message })
    console.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.get('/api/state', async () => store.state())

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

  // Server-sent events: the full state after every change.
  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = () => res.write(`event: state\ndata: ${JSON.stringify(store.state())}\n\n`)
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    store.on('change', send)
    send()
    req.raw.on('close', () => {
      clearInterval(ping)
      store.off('change', send)
    })
  })

  const distDir = opts.distDir === undefined ? path.join(ROOT, 'dist') : opts.distDir
  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: distDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html')
      return reply.code(404).send({ error: 'Not found' })
    })
  }

  return { app, store }
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
