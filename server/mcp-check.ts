// An on-demand check of one MCP server: start it (or connect), do the MCP
// handshake, list its tools, and stop it again. stdio servers run as a child
// process group that is always stopped; http servers get the Streamable HTTP
// handshake, sse servers the legacy one. Errors and logs are masked, and the
// server's own secret values are scrubbed out of them.
import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { McpCheck, McpTool, McpTransport } from '../shared/claude-setup.ts'
import { maskArgs, maskText, scrub } from './mask.ts'

export const PROTOCOL = '2025-11-25'
const CLIENT = { name: 'workbench', version: '1.0.0' }

export interface CheckTarget {
  transport: McpTransport
  config: Record<string, unknown>
  pluginRoot?: string
}

export interface CheckOptions {
  /** Where a stdio server starts: the project folder, or home. */
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

type Json = Record<string, any>
interface Session {
  request(method: string, params?: Json): Promise<any>
  notify(method: string): Promise<void>
  /** After initialize: HTTP sends it on every later request. */
  protocol?: string
  close(): Promise<void>
}

class RpcError extends Error {
  code: number | undefined
  constructor(error: Json) {
    super(typeof error?.message === 'string' ? error.message : 'Error from the server')
    this.code = typeof error?.code === 'number' ? error.code : undefined
  }
}
class AuthNeeded extends Error {}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const strings = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : [])
const parse = (text: string): Json | null => {
  try {
    const v = JSON.parse(text)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** `${VAR}` and `${VAR:-default}`, as claude expands them; `${CLAUDE_PLUGIN_ROOT}` for plugins. */
function expander(env: NodeJS.ProcessEnv, pluginRoot: string | undefined) {
  const vars: NodeJS.ProcessEnv = { ...env, ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}) }
  return (s: unknown) =>
    String(s ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      const v = vars[name]
      return v !== undefined && v !== '' ? v : (fallback ?? '')
    })
}

/** Server-sent events from a response body, one `{event, data}` per event. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n')
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue
          const at = line.indexOf(':')
          const field = at < 0 ? line : line.slice(0, at)
          const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '')
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
        if (data.length) yield { event, data: data.join('\n') }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function handshake(s: Session): Promise<Pick<McpCheck, 'protocolVersion' | 'server' | 'tools'>> {
  let info: Json | null = null
  try {
    info = await s.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT })
  } catch (err) {
    // A newer server may have no handshake at all; tools/list still answers.
    if (!(err instanceof RpcError && err.code === -32601)) throw err
  }
  if (info) {
    if (typeof info.protocolVersion === 'string') s.protocol = info.protocolVersion
    await s.notify('notifications/initialized')
  }
  const tools: McpTool[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await s.request('tools/list', cursor ? { cursor } : undefined)
    for (const t of Array.isArray(res?.tools) ? res.tools : []) {
      if (!isObj(t) || typeof t.name !== 'string') continue
      const d = typeof t.description === 'string' ? t.description.trim() : ''
      tools.push({ name: t.name, ...(d ? { description: d.length > 600 ? `${d.slice(0, 600)}…` : d } : {}) })
    }
    cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined
    if (!cursor) break
  }
  const si = isObj(info?.serverInfo) ? info.serverInfo : null
  const server = si ? `${si.name ?? ''} ${si.version ?? ''}`.trim() : ''
  return { ...(typeof info?.protocolVersion === 'string' ? { protocolVersion: info.protocolVersion } : {}), ...(server ? { server } : {}), tools }
}

/** Stop the server's whole process group: close its input, then TERM, then KILL. */
async function stop(child: ChildProcess) {
  const pid = child.pid
  if (!pid) return
  const exited = child.exitCode !== null || child.signalCode !== null
  const gone = exited ? Promise.resolve() : new Promise((done) => child.once('exit', done))
  child.stdin?.end()
  if (!exited) await Promise.race([gone, delay(300)])
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s)
    } catch {
      // Gone already.
    }
  }
  signal('SIGTERM')
  await Promise.race([gone, delay(2000)])
  signal('SIGKILL')
}

function stdioSession(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let log = ''
  child.stderr!.on('data', (d) => (log = (log + d).slice(-8000)))
  child.stdin!.on('error', () => {})
  // 'close' comes after its output is read, so the log is complete.
  const failed = new Promise<never>((_, reject) => {
    child.on('error', (err: NodeJS.ErrnoException) => reject(new Error(err.code === 'ENOENT' ? `Command not found: ${command}` : err.message)))
    child.on('close', (code, sig) => reject(new Error(sig ? `It stopped (${sig}) before answering` : `It exited with code ${code} before answering`)))
  })
  failed.catch(() => {})
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const write = (msg: Json) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    const msg = parse(line)
    if (!msg) return
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      // The server asks something: answer pings, refuse the rest.
      write(msg.method === 'ping' ? { id: msg.id, result: {} } : { id: msg.id, error: { code: -32601, message: 'Method not found' } })
      return
    }
    const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new RpcError(msg.error))
    else p.resolve(msg.result)
  })
  let nextId = 1
  const session: Session = {
    request(method, params) {
      const id = nextId++
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      write({ id, method, ...(params ? { params } : {}) })
      return Promise.race([answer, failed])
    },
    async notify(method) {
      write({ method })
    },
    close: () => stop(child),
  }
  return { session, log: () => log }
}

async function failure(res: Response): Promise<Error> {
  if (res.status === 401 || res.status === 403) return new AuthNeeded()
  const text = (await res.text().catch(() => '')).trim()
  return new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
}

function httpSession(url: string, headers: Record<string, string>, signal: AbortSignal): Session {
  let sessionId: string | undefined
  let nextId = 1
  const session: Session = {
    async request(method, params) {
      const reply = await post({ id: nextId++, method, ...(params ? { params } : {}) })
      if (!reply) throw new Error(`No answer to ${method}`)
      if (reply.error) throw new RpcError(reply.error)
      return reply.result
    },
    async notify(method) {
      await post({ method })
    },
    async close() {
      if (!sessionId) return
      await fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(2000) })
        .then((r) => r.body?.cancel())
        .catch(() => {})
    },
  }
  async function post(msg: Json): Promise<Json | null> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(session.protocol ? { 'mcp-protocol-version': session.protocol } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...msg }),
      signal,
    })
    if (!res.ok) throw await failure(res)
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    if (res.status === 202 || msg.id === undefined) {
      await res.body?.cancel()
      return null
    }
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return parse(await res.text())
    for await (const ev of sseEvents(res.body!)) {
      const m = parse(ev.data)
      if (m && m.id === msg.id && !m.method) return m
    }
    throw new Error('The stream ended without an answer')
  }
  return session
}

/** The legacy SSE transport: a stream that names an endpoint to post to, and carries the answers. */
async function sseSession(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Session> {
  const stream = new AbortController()
  signal.addEventListener('abort', () => stream.abort(), { once: true })
  const res = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: stream.signal })
  if (!res.ok) throw await failure(res)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let endpoint: (u: string) => void = () => {}
  const endpointKnown = new Promise<string>((done) => (endpoint = done))
  const ended = (async () => {
    for await (const ev of sseEvents(res.body!)) {
      if (ev.event === 'endpoint') endpoint(new URL(ev.data, url).href)
      const m = ev.event === 'message' ? parse(ev.data) : null
      const p = m && typeof m.id === 'number' && !m.method ? pending.get(m.id) : undefined
      if (!m || !p) continue
      pending.delete(m.id)
      if (m.error) p.reject(new RpcError(m.error))
      else p.resolve(m.result)
    }
    throw new Error('The stream ended')
  })()
  ended.catch(() => {})
  const target = await Promise.race([endpointKnown, ended])
  const post = async (msg: Json) => {
    const r = await fetch(target, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...msg }), signal })
    if (!r.ok) throw await failure(r)
    await r.body?.cancel()
  }
  let nextId = 1
  return {
    async request(method, params) {
      const id = nextId++
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      await post({ id, method, ...(params ? { params } : {}) })
      return Promise.race([answer, ended])
    },
    notify: (method) => post({ method }),
    async close() {
      stream.abort()
    },
  }
}

const errorText = (err: unknown) => {
  const cause = (err as { cause?: { code?: string } }).cause
  return cause?.code ? `Cannot reach it (${cause.code})` : err instanceof Error ? err.message : String(err)
}

/** The last lines of a log. */
const tail = (log: string) => log.trim().split('\n').slice(-20).join('\n')

export async function checkServer(t: CheckTarget, opts: CheckOptions): Promise<McpCheck> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 30_000
  const expand = expander(opts.env ?? process.env, t.pluginRoot)
  const c = t.config
  const env = Object.fromEntries(Object.entries(isObj(c.env) ? c.env : {}).map(([k, v]) => [k, expand(v)]))
  const headers = Object.fromEntries(Object.entries(isObj(c.headers) ? c.headers : {}).map(([k, v]) => [k, expand(v)]))
  const rawArgs = strings(c.args)
  const masked = maskArgs(rawArgs)
  const secrets = [...Object.values(env), ...Object.values(headers), ...rawArgs.filter((a, i) => masked[i] !== a).map(expand)]
  const clean = (s: string) => maskText(scrub(s, secrets))

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer in ${Math.round(timeoutMs / 1000)} s`))
      controller.abort()
    }, timeoutMs)
  })
  let session: Session | null = null
  let log = () => ''
  try {
    const open = async (): Promise<Session> => {
      if (t.transport === 'stdio') {
        const s = stdioSession(expand(c.command), rawArgs.map(expand), { ...(opts.env ?? process.env), ...env }, opts.cwd)
        log = s.log
        return s.session
      }
      if (t.transport === 'http') return httpSession(expand(c.url), headers, controller.signal)
      if (t.transport === 'sse') return sseSession(expand(c.url), headers, controller.signal)
      throw new Error(`${t.transport} servers cannot be checked here`)
    }
    const result = await Promise.race([
      (async () => {
        session = await open()
        return handshake(session)
      })(),
      timeout,
    ])
    const tools = result.tools.map((x) => ({ ...x, ...(x.description ? { description: clean(x.description) } : {}) }))
    return { ok: true, ms: Date.now() - started, ...result, ...(result.server ? { server: clean(result.server) } : {}), tools }
  } catch (err) {
    if (err instanceof AuthNeeded) return { ok: false, ms: Date.now() - started, tools: [], needsAuth: true, error: 'Needs sign-in: run /mcp in claude' }
    const text = tail(log())
    return { ok: false, ms: Date.now() - started, tools: [], error: clean(errorText(err)), ...(text ? { log: clean(text) } : {}) }
  } finally {
    clearTimeout(timer)
    await (session as Session | null)?.close().catch(() => {})
    controller.abort()
  }
}
