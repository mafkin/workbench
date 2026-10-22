import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseNetTcp } from '../server/procfs.ts'
import { buildServer } from '../server/main.ts'

const NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A2C4 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1777 1 0000000000000000 100 0 0 10 0
`
const NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:14E9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 52000 1 0000000000000000 100 0 0 10 0
`

describe('reading listening sockets', () => {
  it('keeps listening sockets with their port, address and inode', () => {
    expect(parseNetTcp(NET_TCP, 4)).toEqual([
      { port: 8080, address: '127.0.0.1', inode: 41234, uid: 1000 },
      { port: 22, address: '0.0.0.0', inode: 1777, uid: 0 },
    ])
    expect(parseNetTcp(NET_TCP6, 6)).toEqual([{ port: 5353, address: '::1', inode: 52000, uid: 1000 }])
  })
})

const SERVER = `
const http = require('node:http')
const s = http.createServer((req, res) => res.end('hi'))
s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port))
`
const RAW = `
const net = require('node:net')
const s = net.createServer((c) => c.end())
s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port))
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
const children: ChildProcess[] = []
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

/** A real server process started in `cwd`; resolves with its pid and port. */
function start(code: string, cwd: string): Promise<{ pid: number; port: number; child: ChildProcess }> {
  const child = spawn(process.execPath, ['-e', code], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  children.push(child)
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d) => {
      const m = /PORT (\d+)/.exec(String(d))
      if (m) resolve({ pid: child.pid!, port: Number(m[1]), child })
    })
    child.on('error', reject)
  })
}

const call = async (method: 'GET' | 'POST', url: string, payload?: object, h = headers) => {
  const res = await server.app.inject({ method, url, headers: h, payload })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-servers-')))
  home = path.join(dir, 'home')
  for (const d of ['alpha/web', 'beta', 'outside']) await fsp.mkdir(path.join(home, d), { recursive: true })
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'cfg/profiles/work.yaml'),
    `name: Work
sections:
  - title: Projects
    items:
      - label: Alpha
        type: folder
        path: ~/alpha
        servers:
          - { name: api, url: "http://127.0.0.1:1/health" }
      - { label: Beta, type: folder, path: ~/beta }
`,
  )
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state') })
})

afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL')
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('servers running in projects', { timeout: 15_000 }, () => {
  it('finds your servers by the folder they run in, with health; declared ones show down', async () => {
    const web = await start(SERVER, path.join(home, 'alpha/web'))
    const raw = await start(RAW, path.join(home, 'beta'))
    const away = await start(SERVER, path.join(home, 'outside'))
    const { body } = await call('GET', '/api/servers?profile=work')
    const alpha = body.projects.find((p: { label: string }) => p.label === 'Alpha')
    const beta = body.projects.find((p: { label: string }) => p.label === 'Beta')
    expect(alpha.rows).toEqual([
      expect.objectContaining({ port: web.port, pid: web.pid, process: 'node', cwd: '~/alpha/web', url: `http://127.0.0.1:${web.port}/`, health: expect.objectContaining({ state: 'up', code: 200 }) }),
      expect.objectContaining({ name: 'api', declared: true, port: null, health: expect.objectContaining({ state: 'down' }) }),
    ])
    expect(alpha.rows[0].started).toBeGreaterThan(Date.now() - 60_000)
    expect(beta.rows).toEqual([expect.objectContaining({ port: raw.port, health: expect.objectContaining({ state: 'listening' }) })])
    expect(JSON.stringify(body)).not.toContain(String(away.port))
  })

  it('a declared server with a port merges with the one running there', async () => {
    const web = await start(SERVER, path.join(home, 'alpha'))
    const text = await fsp.readFile(path.join(dir, 'cfg/profiles/work.yaml'), 'utf8')
    await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), text.replace('{ name: api, url: "http://127.0.0.1:1/health" }', `{ name: web, port: ${web.port} }`))
    await server.store.init({ watch: false, seed: false })
    const { body } = await call('GET', '/api/servers?profile=work')
    const alpha = body.projects.find((p: { label: string }) => p.label === 'Alpha')
    expect(alpha.rows).toEqual([expect.objectContaining({ name: 'web', declared: true, port: web.port, pid: web.pid, health: expect.objectContaining({ state: 'up' }) })])
  })

  it('stops only a server it lists, and only with the header', async () => {
    const web = await start(SERVER, path.join(home, 'alpha'))
    const away = await start(SERVER, path.join(home, 'outside'))
    expect((await call('POST', '/api/servers/stop', { profile: 'work', pid: away.pid, port: away.port })).status).toBe(404)
    expect((await call('POST', '/api/servers/stop', { profile: 'work', pid: web.pid, port: web.port + 1 })).status).toBe(404)
    expect((await call('POST', '/api/servers/stop', { profile: 'work', pid: web.pid, port: web.port }, { host: '127.0.0.1:7420' } as typeof headers)).status).toBe(403)
    const exited = new Promise((r) => web.child.on('exit', r))
    expect((await call('POST', '/api/servers/stop', { profile: 'work', pid: web.pid, port: web.port })).status).toBe(200)
    await exited
    expect(away.child.exitCode).toBeNull()
  })
})
