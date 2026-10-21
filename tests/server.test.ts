import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandHome } from '../shared/config-schema.ts'
import { makeGuard } from '../server/guard.ts'
import { launchFor, openItem, runDetached } from '../server/launch.ts'
import { buildServer } from '../server/main.ts'

interface Call {
  command: string
  args: string[]
  options: Record<string, unknown>
}

function fakeSpawn(fail?: string) {
  const calls: Call[] = []
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    setImmediate(() => {
      if (fail) child.emit('error', Object.assign(new Error(fail), { code: fail }))
      else child.emit('spawn')
    })
    return child
  }) as any
  return { spawn, calls }
}

describe('expandHome', () => {
  it('expands a leading ~ and =~/ but nothing else', () => {
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome('~/x', '/h')).toBe('/h/x')
    expect(expandHome('--dir=~/x', '/h')).toBe('--dir=/h/x')
    expect(expandHome('a~/x', '/h')).toBe('a~/x')
    expect(expandHome('~user/x', '/h')).toBe('~user/x')
  })
})

describe('guard', () => {
  const check = makeGuard([7420])
  const ok = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  it('allows the app itself', () => {
    expect(check(ok, '/api/state')).toBeNull()
    expect(check({ ...ok, origin: 'http://localhost:7420', host: 'localhost:7420' }, '/api/open')).toBeNull()
    expect(check({ host: '127.0.0.1:7420' }, '/')).toBeNull()
  })

  it('rejects a foreign Host (DNS rebinding)', () => {
    expect(check({ ...ok, host: 'evil.test:7420' }, '/api/state')).toMatch(/Host/)
    expect(check({ ...ok, host: '127.0.0.1:9999' }, '/api/state')).toMatch(/Host/)
    expect(check({ 'x-workbench': '1' }, '/api/state')).toMatch(/Host/)
  })

  it('rejects a foreign Origin', () => {
    expect(check({ ...ok, origin: 'https://evil.test' }, '/api/open')).toMatch(/Origin/)
    expect(check({ ...ok, 'sec-fetch-site': 'cross-site' }, '/api/open')).toMatch(/Cross-site/)
  })

  it('requires the API header', () => {
    expect(check({ host: '127.0.0.1:7420' }, '/api/open')).toMatch(/X-Workbench/)
  })
})

describe('launch', () => {
  it('builds launchers without a shell and expands ~', async () => {
    const { spawn, calls } = fakeSpawn()
    const launch = launchFor(
      { type: 'launch', label: 'T', command: 'gnome-terminal', args: ['--working-directory=~/p', '--', 'claude'] },
      '/home/u',
    )
    await runDetached(launch, spawn)
    expect(calls[0].command).toBe('gnome-terminal')
    expect(calls[0].args).toEqual(['--working-directory=/home/u/p', '--', 'claude'])
    expect(calls[0].options).toMatchObject({ shell: false, detached: true, stdio: 'ignore' })
  })

  it('opens links and paths with xdg-open', () => {
    expect(launchFor({ type: 'link', label: 'L', url: 'https://x.test/' }, '/h')).toEqual({ command: 'xdg-open', args: ['https://x.test/'] })
    expect(launchFor({ type: 'note', label: 'N', path: '~/n.md' }, '/h').args).toEqual(['/h/n.md'])
  })

  it('reports a missing command', async () => {
    const { spawn } = fakeSpawn('ENOENT')
    await expect(runDetached({ command: 'nope', args: [] }, spawn)).rejects.toThrow('Command not found: nope')
  })

  it('reports a missing path or working folder before spawning', async () => {
    const { spawn, calls } = fakeSpawn()
    await expect(openItem({ type: 'folder', label: 'F', path: '~/does-not-exist-xyz' }, os.tmpdir(), spawn)).rejects.toThrow(
      'Not found: ~/does-not-exist-xyz',
    )
    await expect(
      openItem({ type: 'launch', label: 'L', command: 'ls', args: [], cwd: '~/missing-xyz' }, os.tmpdir(), spawn),
    ).rejects.toThrow('Folder not found: ~/missing-xyz')
    expect(calls).toHaveLength(0)
  })
})

describe('HTTP API', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof buildServer>>
  let spawn: ReturnType<typeof fakeSpawn>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-api-'))
    await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
    await fsp.mkdir(path.join(dir, 'home/proj'), { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'cfg/profiles/work.yaml'),
      `name: Work
sections:
  - title: Projects
    items:
      - { label: Proj, type: folder, path: ~/proj }
      - { label: Shell, type: launch, command: echo, args: [hi] }
      - { label: Card, type: project, project: p1 }
`,
    )
    spawn = fakeSpawn()
    server = await buildServer({
      configDir: path.join(dir, 'cfg'),
      port: 7420,
      distDir: null,
      home: path.join(dir, 'home'),
      spawn: spawn.spawn,
      watch: false,
    })
  })

  afterEach(async () => {
    await server.app.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  const state = async () => (await server.app.inject({ method: 'GET', url: '/api/state', headers })).json()

  it('refuses a request without the header', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:7420' } })
    expect(res.statusCode).toBe(403)
  })

  it('returns state and applies ops', async () => {
    const s = await state()
    expect(s.activeProfile).toBe('work')
    const rev = s.profiles[0].rev
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/profiles/work/ops',
      headers,
      payload: { rev, ops: [{ op: 'addSection', title: 'Docs' }] },
    })
    expect(res.statusCode).toBe(200)
    expect((await state()).profiles[0].profile.sections.map((x: any) => x.title)).toEqual(['Projects', 'Docs'])
  })

  it('validates the request body', async () => {
    const rev = (await state()).profiles[0].rev
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/profiles/work/ops',
      headers,
      payload: { rev, ops: [{ op: 'explode' }] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 409 for a stale revision', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/profiles/work/ops',
      headers,
      payload: { rev: 'old', ops: [{ op: 'addSection', title: 'Docs' }] },
    })
    expect(res.statusCode).toBe(409)
  })

  it('opens an entry by address, never by a command in the request', async () => {
    const rev = (await state()).profiles[0].rev
    const open = (index: number) =>
      server.app.inject({ method: 'POST', url: '/api/open', headers, payload: { profile: 'work', rev, at: { section: 0, index } } })
    expect((await open(0)).statusCode).toBe(200)
    expect((await open(1)).statusCode).toBe(200)
    expect(spawn.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['xdg-open', path.join(dir, 'home/proj')],
      ['echo', 'hi'],
    ])
    expect((await open(2)).statusCode).toBe(422)
    expect((await open(7)).statusCode).toBe(404)
  })

  it('stats a path relative to home', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/stat?path=~/proj', headers })
    expect(res.json()).toEqual({ exists: true, kind: 'dir' })
  })
})
