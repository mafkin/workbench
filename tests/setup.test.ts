// Setup (part 13): the service without a Workbench folder, and the route that gives it one.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer, defaultWorkbenchDir } from '../server/main.ts'
import { seedWorkbench } from '../server/seed.ts'

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

async function call<T = any>(method: 'GET' | 'POST', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers, payload })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-setup-')))
  home = path.join(dir, 'home')
  await fsp.mkdir(home, { recursive: true })
  server = await buildServer({ dir: null, pointerFile: path.join(dir, 'config/workbench/dir'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state') })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the service without a Workbench folder', () => {
  it('reports setup in its state and answers 409 to everything else, until the setup route names a folder', async () => {
    const before = await call('GET', '/api/state')
    expect(before.body).toMatchObject({ setup: { suggested: '~/Workbench' }, profiles: [], activeProfile: '' })
    expect(before.body.dir).toBeUndefined()
    expect((await call('GET', '/api/notes/list?profile=main')).status).toBe(409)
    expect((await call('POST', '/api/profiles', { id: 'x', name: 'X' })).status).toBe(409)
    expect((await call('GET', '/api/health')).status).toBe(200)

    const made = await call('POST', '/api/setup', { dir: '~/Workbench', name: 'My Bench' })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    expect(made.body).toMatchObject({ activeProfile: 'my-bench', dir: '~/Workbench' })
    expect(made.body.setup).toBeUndefined()
    expect(made.body.profiles.map((p: { id: string }) => p.id)).toEqual(['my-bench'])
    // The layout: settings, the profile, its drawer page and the drawer's folder.
    expect(await fsp.readFile(path.join(home, 'Workbench/settings.yaml'), 'utf8')).toContain('activeProfile: my-bench\nprofiles:\n  - my-bench\n')
    expect(await fsp.readFile(path.join(home, 'Workbench/my-bench/index.md'), 'utf8')).toBe('---\nname: "My Bench"\naccent: "#7d93ab"\n---\n## Drawers\n\n- [[drawers/My Bench]]\n')
    expect(await fsp.readFile(path.join(home, 'Workbench/my-bench/drawers/My Bench.md'), 'utf8')).toBe('## My Bench\n')
    expect((await fsp.stat(path.join(home, 'Workbench/my-bench/drawers/My Bench'))).isDirectory()).toBe(true)
    // Remembered for the next start.
    expect(await fsp.readFile(path.join(dir, 'config/workbench/dir'), 'utf8')).toBe(`${path.join(home, 'Workbench')}\n`)
    // The rest of the API works now, rooted there.
    const notes = await call('GET', '/api/notes/list?profile=my-bench')
    expect(notes.status).toBe(200)
    expect(notes.body.map((n: { path: string }) => n.path)).toContain('~/Workbench/my-bench/index.md')
    expect((await call('GET', '/api/state')).body.setup).toBeUndefined()
    // Once is enough.
    expect((await call('POST', '/api/setup', { dir: '~/Other', name: 'Again' })).status).toBe(409)
  })

  it('validates the request: a folder is required, and it must be ~/… or absolute', async () => {
    expect((await call('POST', '/api/setup', { dir: '', name: 'X' })).status).toBe(400)
    expect((await call('POST', '/api/setup', { dir: 'relative/path', name: 'X' })).status).toBe(400)
    expect((await call('GET', '/api/state')).body.setup).toBeDefined()
  })

  it('adopts a folder that already is a Workbench instead of seeding it again', async () => {
    await seedWorkbench(path.join(home, 'Existing'), { id: 'work', name: 'Work' })
    await fsp.writeFile(path.join(home, 'Existing/work/Ideas.md'), '# Ideas\n')
    const made = await call('POST', '/api/setup', { dir: path.join(home, 'Existing'), name: 'Ignored' })
    expect(made.status).toBe(200)
    expect(made.body.profiles.map((p: { id: string }) => p.id)).toEqual(['work'])
    expect(await fsp.readdir(path.join(home, 'Existing'))).toEqual(['settings.yaml', 'work'])
  })
})

describe('where the folder comes from at start', () => {
  const saved = { dir: process.env.WORKBENCH_DIR, xdg: process.env.XDG_CONFIG_HOME }
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.WORKBENCH_DIR
    else process.env.WORKBENCH_DIR = saved.dir
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.xdg
  })

  it('WORKBENCH_DIR first, then the pointer file under the XDG config dir, else none', async () => {
    process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg')
    delete process.env.WORKBENCH_DIR
    expect(defaultWorkbenchDir()).toBeNull()
    await fsp.mkdir(path.join(dir, 'xdg/workbench'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'xdg/workbench/dir'), `${path.join(dir, 'from-pointer')}\n`)
    expect(defaultWorkbenchDir()).toBe(path.join(dir, 'from-pointer'))
    process.env.WORKBENCH_DIR = path.join(dir, 'from-env')
    expect(defaultWorkbenchDir()).toBe(path.join(dir, 'from-env'))
  })

  it('a folder given at start without settings.yaml is seeded with a profile named Main', async () => {
    const given = await buildServer({ dir: path.join(dir, 'given'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state2') })
    try {
      const res = await given.app.inject({ method: 'GET', url: '/api/state', headers })
      expect(res.json()).toMatchObject({ activeProfile: 'main', dir: path.join(dir, 'given') })
      expect((await fsp.stat(path.join(dir, 'given/main/drawers/Main'))).isDirectory()).toBe(true)
    } finally {
      await given.app.close()
    }
  })
})
