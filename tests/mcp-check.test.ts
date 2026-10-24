import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkServer } from '../server/mcp-check.ts'

const FIXTURES = path.resolve('tests/fixtures')
const FAKE_MCP = path.join(FIXTURES, 'fake-mcp.mjs')
const node = process.execPath

let dir: string
beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-mcp-')))
})
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const stdio = (env: Record<string, string> = {}, args = [FAKE_MCP]) => ({ transport: 'stdio' as const, config: { command: node, args, env } })
/** The process is running (a zombie waiting to be reaped counts as gone). */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return false
  }
}
const gone = async (pid: number) => {
  const end = Date.now() + 3000
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  return !alive(pid)
}

describe('checking a stdio server', () => {
  it('starts it in the folder with its env, lists its tools and stops it', async () => {
    const pidFile = path.join(dir, 'pid')
    const result = await checkServer(stdio({ FAKE_MCP_GREETING: '${GREETING:-hi there}', FAKE_MCP_PIDFILE: pidFile }), { cwd: dir, env: { PATH: process.env.PATH } })
    expect(result).toMatchObject({ ok: true, server: 'fake-mcp 1.2.3', protocolVersion: '2025-11-25' })
    expect(result.tools.map((t) => t.name)).toEqual(['echo', 'add', 'cwd'])
    expect(result.tools[0].description).toBe('Says it back. Greeting: HI THERE')
    expect(result.tools[2].description).toBe(`Runs in ${dir}`)
    expect(alive(Number(await fsp.readFile(pidFile, 'utf8')))).toBe(false)
  })

  it('expands ${VAR} from the environment and ${CLAUDE_PLUGIN_ROOT} for plugins', async () => {
    const result = await checkServer(
      { transport: 'stdio', config: { command: node, args: ['${CLAUDE_PLUGIN_ROOT}/fake-mcp.mjs'], env: { FAKE_MCP_GREETING: '${GREETING}' } }, pluginRoot: FIXTURES },
      { cwd: dir, env: { PATH: process.env.PATH, GREETING: 'from env' } },
    )
    expect(result.ok).toBe(true)
    expect(result.tools[0].description).toBe('Says it back. Greeting: FROM ENV')
  })

  it('follows pages, skips lines that are not JSON, and copes without initialize', async () => {
    expect((await checkServer(stdio({ FAKE_MCP_MODE: 'paged' }), { cwd: dir })).tools).toHaveLength(3)
    expect((await checkServer(stdio({ FAKE_MCP_MODE: 'garbage' }), { cwd: dir })).ok).toBe(true)
    const noinit = await checkServer(stdio({ FAKE_MCP_MODE: 'noinit' }), { cwd: dir })
    expect(noinit).toMatchObject({ ok: true, tools: expect.arrayContaining([expect.objectContaining({ name: 'echo' })]) })
  })

  it('reports a crash with the end of its log, secrets scrubbed', async () => {
    const result = await checkServer(stdio({ FAKE_MCP_MODE: 'crash', FAKE_MCP_TOKEN: 'tok-SECRET-123' }), { cwd: dir })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/exited with code 3/i)
    expect(result.log).toContain('cannot reach the database')
    expect(result.log).not.toContain('tok-SECRET-123')
  })

  it('gives up on a server that does not answer, and stops it and its children even when it ignores TERM', { timeout: 10_000 }, async () => {
    const pidFile = path.join(dir, 'pid')
    const result = await checkServer(stdio({ FAKE_MCP_MODE: 'hang', FAKE_MCP_PIDFILE: pidFile }), { cwd: dir, timeoutMs: 600 })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/no answer/i) })
    expect(await gone(Number(await fsp.readFile(pidFile, 'utf8')))).toBe(true)
    expect(await gone(Number(await fsp.readFile(`${pidFile}.child`, 'utf8')))).toBe(true)
  })

  it('says when the command is not there', async () => {
    const result = await checkServer({ transport: 'stdio', config: { command: 'wb-no-such-command-xyz' } }, { cwd: dir })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not found/i) })
  })
})

/** A small MCP server over HTTP: Streamable HTTP at /mcp, the legacy SSE transport at /sse. */
function httpServer() {
  const seen = { deleted: false, protocol: [] as (string | undefined)[] }
  let sse: http.ServerResponse | null = null
  const answer = (msg: any) => {
    if (msg.method === 'initialize') return { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'web-mcp', version: '0.9' } }
    if (msg.method === 'tools/list') return { tools: [{ name: 'search', description: 'Searches the web' }] }
    return null
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/locked') return res.writeHead(401).end('{"error":"sign in"}')
      if (req.url === '/sse' && req.method === 'GET') {
        sse = res
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: endpoint\ndata: /messages?session=7\n\n')
        return
      }
      if (req.url?.startsWith('/messages')) {
        const msg = JSON.parse(body)
        res.writeHead(202).end()
        const result = answer(msg)
        if (result && sse) sse.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`)
        return
      }
      if (req.method === 'DELETE') {
        seen.deleted = req.headers['mcp-session-id'] === 'sess-1'
        return res.writeHead(200).end()
      }
      if (req.headers.authorization !== 'Bearer abc') return res.writeHead(401).end()
      const msg = JSON.parse(body)
      if (msg.method !== 'initialize') {
        seen.protocol.push(req.headers['mcp-protocol-version'] as string | undefined)
        if (req.headers['mcp-session-id'] !== 'sess-1') return res.writeHead(400).end('no session')
      }
      if (msg.id === undefined) return res.writeHead(202).end()
      const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg) })
      // initialize answers as JSON, tools/list as an event stream: clients must take both.
      if (msg.method === 'initialize') return res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(reply)
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${reply}\n\n`)
    })
  })
  return { server, seen, close: () => new Promise<void>((done) => (sse?.end(), server.closeAllConnections(), server.close(() => done()))) }
}

describe('checking an http or sse server', () => {
  let web: ReturnType<typeof httpServer>
  let base: string
  beforeEach(async () => {
    web = httpServer()
    await new Promise<void>((done) => web.server.listen(0, '127.0.0.1', () => done()))
    base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`
  })
  afterEach(() => web.close())

  it('does the Streamable HTTP handshake with its headers, then ends the session', async () => {
    const result = await checkServer({ transport: 'http', config: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer ${API_TOKEN}' } } }, { cwd: dir, env: { API_TOKEN: 'abc' } })
    expect(result).toMatchObject({ ok: true, server: 'web-mcp 0.9', tools: [{ name: 'search', description: 'Searches the web' }] })
    expect(web.seen.protocol).toEqual(['2025-11-25', '2025-11-25'])
    expect(web.seen.deleted).toBe(true)
  })

  it('a server that wants a sign-in says so', async () => {
    const result = await checkServer({ transport: 'http', config: { type: 'http', url: `${base}/locked` } }, { cwd: dir })
    expect(result).toMatchObject({ ok: false, needsAuth: true })
  })

  it('speaks the legacy SSE transport', async () => {
    const result = await checkServer({ transport: 'sse', config: { type: 'sse', url: `${base}/sse` } }, { cwd: dir })
    expect(result).toMatchObject({ ok: true, server: 'web-mcp 0.9', tools: [{ name: 'search' }] })
  })

  it('reports a server that is not there', async () => {
    await web.close()
    const result = await checkServer({ transport: 'http', config: { type: 'http', url: `${base}/mcp` } }, { cwd: dir })
    expect(result).toMatchObject({ ok: false, error: 'Cannot reach it (ECONNREFUSED)' })
  })
})
