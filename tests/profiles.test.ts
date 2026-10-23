import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server/main.ts'
import { migrateFixture } from './fixtures/wiki.ts'

const WORK = `# My work setup
name: Work
accent: "#7d93ab"
notes: ~/notes
# Every project starts with these
workflow:
  - { label: sources, type: folder, path: src }
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha }
`
const PERSONAL = `name: Personal
accent: "#8fa58a"
sections: []
`

let dir: string
let server: Awaited<ReturnType<typeof buildServer>>
let spawned: string[]
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

/** gio trash moves the file into dir/trash. */
function fakeSpawn(command: string, args: string[]) {
  spawned.push([command, ...args].join(' '))
  if (command === 'gio' && args[0] === 'trash') {
    fs.mkdirSync(path.join(dir, 'trash'), { recursive: true })
    for (const p of args.slice(2)) fs.renameSync(p, path.join(dir, 'trash', path.basename(p)))
  }
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => {
    child.emit('spawn')
    child.emit('close', 0)
  })
  return child
}

async function call<T = any>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers, payload })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

const cfg = (rel: string) => path.join(dir, 'cfg', rel)
const ids = () => server.store.state().profiles.map((p) => p.id)

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-profiles-')))
  spawned = []
  await fsp.mkdir(cfg('profiles'), { recursive: true })
  await fsp.writeFile(cfg('settings.yaml'), '# order of the switcher\nactiveProfile: work\nprofiles: [work, personal]\n')
  await fsp.writeFile(cfg('profiles/work.yaml'), WORK)
  await fsp.writeFile(cfg('profiles/personal.yaml'), PERSONAL)
  await migrateFixture(path.join(dir, 'cfg'), path.join(dir, 'home'), { defaultWiki: (id) => path.join(dir, 'wiki', id) })
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home: path.join(dir, 'home'), watch: false, stateDir: path.join(dir, 'state'), spawn: fakeSpawn as any })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

const wiki = (rel: string) => path.join(dir, 'home', rel)

describe('adding and removing profiles', () => {
  it('adds a blank profile as a new wiki, last in the switcher', async () => {
    const res = await call('POST', '/api/profiles', { id: 'games', name: 'Games', wiki: '~/games' })
    expect(res.status).toBe(200)
    expect(ids()).toEqual(['work', 'personal', 'games'])
    const text = await fsp.readFile(wiki('games/index.md'), 'utf8')
    expect(text).toMatch(/^---\nname: "Games"\naccent: "#[0-9a-f]{6}"\n---\n## Start\n$/)
    expect(server.store.profile('games').profile?.accent).not.toBe('#7d93ab')
    expect(server.store.profile('games').wiki).toBe('~/games')
    const settings = await fsp.readFile(cfg('settings.yaml'), 'utf8')
    expect(settings).toContain('# order of the switcher')
    expect(settings).toContain('  games: ~/games\n')
  })

  it('copies the current profile’s index.md (its nav) and Workflow.md under a new name', async () => {
    await call('POST', '/api/profiles', { id: 'side', name: 'Side', wiki: '~/side', copyFrom: 'work' })
    const text = await fsp.readFile(wiki('side/index.md'), 'utf8')
    expect(text).toContain('name: Side')
    expect(text).toContain('## Projects\n\n- [[Alpha]]')
    expect(await fsp.readFile(wiki('side/Workflow.md'), 'utf8')).toBe(await fsp.readFile(wiki('notes/Workflow.md'), 'utf8'))
    // The page itself stays in the work wiki: here Alpha is a page to make.
    expect(server.store.profile('side').profile?.sections[0].items[0]).toMatchObject({ type: 'note', label: 'Alpha' })
  })

  it('refuses a taken or odd id, and a wiki another profile has', async () => {
    expect((await call('POST', '/api/profiles', { id: 'work', name: 'Again', wiki: '~/again' })).status).toBe(409)
    expect((await call('POST', '/api/profiles', { id: '../x', name: 'X', wiki: '~/x' })).status).toBe(400)
    expect((await call('POST', '/api/profiles', { id: 'ok', name: '', wiki: '~/ok' })).status).toBe(400)
    expect((await call('POST', '/api/profiles', { id: 'twin', name: 'Twin', wiki: '~/notes' })).status).toBe(409)
    expect(fs.existsSync(wiki('notes/index.md'))).toBe(true)
  })

  it('removes a profile from the switcher, keeping its wiki; the active one moves on; the last one stays', async () => {
    expect((await call('DELETE', '/api/profiles/work')).status).toBe(200)
    expect(spawned).toEqual([])
    expect(fs.existsSync(wiki('notes/index.md'))).toBe(true)
    expect(ids()).toEqual(['personal'])
    expect(server.store.state().activeProfile).toBe('personal')
    expect(await fsp.readFile(cfg('settings.yaml'), 'utf8')).toMatch(/profiles:\n  personal: /)
    expect((await call('DELETE', '/api/profiles/personal')).status).toBe(409)
    expect((await call('DELETE', '/api/profiles/nobody')).status).toBe(404)
  })
})
