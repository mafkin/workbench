import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server/main.ts'

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
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home: path.join(dir, 'home'), watch: false, stateDir: path.join(dir, 'state'), spawn: fakeSpawn as any })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('adding and removing profiles', () => {
  it('adds a blank profile with its own file, last in the switcher', async () => {
    const res = await call('POST', '/api/profiles', { id: 'games', name: 'Games' })
    expect(res.status).toBe(200)
    expect(ids()).toEqual(['work', 'personal', 'games'])
    const text = await fsp.readFile(cfg('profiles/games.yaml'), 'utf8')
    expect(text).toMatch(/^name: Games\naccent: "#[0-9a-f]{6}"\nsections:/m)
    expect(server.store.profile('games').profile?.accent).not.toBe('#7d93ab')
    expect(await fsp.readFile(cfg('settings.yaml'), 'utf8')).toContain('# order of the switcher')
  })

  it('copies the current profile’s headings and workflow, with comments, under a new name', async () => {
    await call('POST', '/api/profiles', { id: 'side', name: 'Side', copyFrom: 'work' })
    const text = await fsp.readFile(cfg('profiles/side.yaml'), 'utf8')
    expect(text).toContain('name: Side')
    expect(text).toContain('# Every project starts with these')
    expect(server.store.profile('side').profile?.sections[0].items[0].label).toBe('Alpha')
  })

  it('refuses a taken or odd id', async () => {
    expect((await call('POST', '/api/profiles', { id: 'work', name: 'Again' })).status).toBe(409)
    expect((await call('POST', '/api/profiles', { id: '../x', name: 'X' })).status).toBe(400)
    expect((await call('POST', '/api/profiles', { id: 'ok', name: '' })).status).toBe(400)
    expect(fs.existsSync(cfg('profiles/work.yaml'))).toBe(true)
  })

  it('removes a profile to the Trash; the active one moves on; the last one stays', async () => {
    expect((await call('DELETE', '/api/profiles/work')).status).toBe(200)
    expect(spawned).toEqual([`gio trash -- ${cfg('profiles/work.yaml')}`])
    expect(fs.existsSync(path.join(dir, 'trash/work.yaml'))).toBe(true)
    expect(ids()).toEqual(['personal'])
    expect(server.store.state().activeProfile).toBe('personal')
    expect(await fsp.readFile(cfg('settings.yaml'), 'utf8')).toMatch(/profiles:\s*\[\s*personal\s*\]|profiles:\n\s+- personal/)
    expect((await call('DELETE', '/api/profiles/personal')).status).toBe(409)
    expect((await call('DELETE', '/api/profiles/nobody')).status).toBe(404)
  })
})
