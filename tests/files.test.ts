import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../server/config-store.ts'
import { Files } from '../server/files.ts'
import { buildServer } from '../server/main.ts'

let dir: string
let home: string
let store: ConfigStore
let files: Files
let spawned: { command: string; args: string[] }[]
let gioFails: string | null
let clock: number

const WORK = `name: Work
home: ~/work
notes: ~/notes
sections:
  - title: Projects
    items:
      - { label: Proj, type: folder, path: ~/proj }
      - label: Group
        type: group
        items:
          - { label: Deep, type: folder, path: ~/deep/folder }
`

const PERSONAL = `name: Personal
home: ~/personal
sections: []
`

/** Spawn that records calls; `gio trash` succeeds (doing nothing) unless `gioFails` is set. */
function fakeSpawn(command: string, args: string[]) {
  spawned.push({ command, args })
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => {
    child.emit('spawn')
    if (gioFails) child.stderr.emit('data', Buffer.from(gioFails))
    child.emit('close', gioFails ? 1 : 0)
  })
  return child
}

async function write(rel: string, data: string | Buffer) {
  const file = path.join(home, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
  return file
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
  return 200
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-files-'))
  home = path.join(dir, 'home')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  await fsp.writeFile(path.join(dir, 'cfg/profiles/personal.yaml'), PERSONAL)
  await write('proj/README.md', '# Proj\n')
  await write('proj/src/main.py', 'print("hi")\n')
  await write('proj/src/file10.py', '')
  await write('proj/src/file9.py', '')
  await write('proj/.env', 'SECRET=1\n')
  await write('proj/.gitignore', 'dist/\n*.log\n')
  await write('proj/dist/out.js', 'x')
  await write('proj/debug.log', 'log')
  await write('proj/logo.png', PNG)
  await write('proj/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await write('proj/song.mp3', Buffer.alloc(1000, 7))
  await write('proj/notes.txt', 'plain text\n')
  await write('proj/run.sh', '#!/bin/sh\n')
  await fsp.chmod(path.join(home, 'proj/run.sh'), 0o755)
  await write('proj/app.desktop', '[Desktop Entry]\n')
  await fsp.mkdir(path.join(home, 'proj/sub/inner'), { recursive: true })
  await write('secret/key.txt', 'top secret\n')
  await fsp.symlink(path.join(home, 'secret'), path.join(home, 'proj/link-out'))
  await write('work/w.txt', 'w')
  await write('notes/n.md', 'n')
  await write('deep/folder/d.txt', 'd')
  await write('personal/p.txt', 'p')
  execFileSync('git', ['init', '-q'], { cwd: path.join(home, 'proj') })
  spawned = []
  gioFails = null
  clock = 1_000_000
  store = new ConfigStore(path.join(dir, 'cfg'))
  await store.init({ watch: false })
  files = new Files(store, home, { spawn: fakeSpawn as any, now: () => clock })
})

afterEach(async () => {
  files.close()
  store.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('which folders the browser may open', () => {
  it('opens home, the notes folder and every folder entry, also inside groups', async () => {
    for (const p of ['~/work', '~/notes', '~/proj', '~/proj/src', '~/deep/folder']) {
      expect(await status(files.list('work', p))).toBe(200)
    }
  })

  it('refuses everything else', async () => {
    expect(await status(files.list('work', '~/secret'))).toBe(403)
    expect(await status(files.list('work', '~/proj/../secret'))).toBe(403)
    expect(await status(files.list('work', '~/deep'))).toBe(403)
    expect(await status(files.list('work', '~/personal'))).toBe(403)
    expect(await status(files.list('work', '~'))).toBe(403)
  })

  it('refuses a symlink that leads out of the roots', async () => {
    expect(await status(files.list('work', '~/proj/link-out'))).toBe(403)
    expect(await status(files.text('work', '~/proj/link-out/key.txt'))).toBe(403)
  })

  it("keeps each profile to its own folders", async () => {
    expect(await status(files.list('personal', '~/personal'))).toBe(200)
    expect(await status(files.list('personal', '~/proj'))).toBe(403)
  })

  it('needs an absolute or ~ path and a known profile', async () => {
    expect(await status(files.list('work', 'proj'))).toBe(400)
    expect(await status(files.list('nobody', '~/proj'))).toBe(404)
  })
})

describe('listing', () => {
  it('lists folders first, names in natural order, with ~ paths', async () => {
    const { path: p, entries } = await files.list('work', '~/proj/src')
    expect(p).toBe('~/proj/src')
    expect(entries.map((e) => e.name)).toEqual(['file9.py', 'file10.py', 'main.py'])
    expect(entries[0]).toMatchObject({ path: '~/proj/src/file9.py', kind: 'file', size: 0, hidden: false, ignored: false })
    const top = await files.list('work', '~/proj')
    const names = top.entries.map((e) => e.name)
    expect(names.indexOf('sub')).toBeLessThan(names.indexOf('README.md'))
  })

  it('flags dotfiles as hidden and .gitignore matches as ignored', async () => {
    const { entries } = await files.list('work', '~/proj')
    const by = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(by['.env'].hidden).toBe(true)
    expect(by['.git'].hidden).toBe(true)
    expect(by['README.md'].hidden).toBe(false)
    expect(by['dist'].ignored).toBe(true)
    expect(by['debug.log'].ignored).toBe(true)
    expect(by['src'].ignored).toBe(false)
  })

  it('marks symlinks and reports what they point to', async () => {
    const { entries } = await files.list('work', '~/proj')
    expect(entries.find((e) => e.name === 'link-out')).toMatchObject({ kind: 'dir', link: true })
  })

  it('ignores nothing outside a git repository', async () => {
    await write('work/x.log', '')
    const { entries } = await files.list('work', '~/work')
    expect(entries.every((e) => !e.ignored)).toBe(true)
  })
})

describe('text previews', () => {
  it('returns text, and flags binary files', async () => {
    expect(await files.text('work', '~/proj/notes.txt')).toMatchObject({ text: 'plain text\n', truncated: false, binary: false })
    expect(await files.text('work', '~/proj/logo.png')).toMatchObject({ text: '', binary: true })
  })

  it('cuts long files at 200 KB', async () => {
    await write('proj/big.txt', 'x'.repeat(300_000))
    const t = await files.text('work', '~/proj/big.txt')
    expect(t.truncated).toBe(true)
    expect(t.text.length).toBe(200 * 1024)
    expect(t.size).toBe(300_000)
  })
})

describe('operations', () => {
  it('renames in place and never overwrites', async () => {
    expect(await files.op('work', { op: 'rename', path: '~/proj/notes.txt', name: 'renamed.txt' })).toEqual({
      path: '~/proj/renamed.txt',
    })
    expect(fs.existsSync(path.join(home, 'proj/renamed.txt'))).toBe(true)
    expect(await status(files.op('work', { op: 'rename', path: '~/proj/renamed.txt', name: 'README.md' }))).toBe(409)
    expect(await fsp.readFile(path.join(home, 'proj/README.md'), 'utf8')).toBe('# Proj\n')
  })

  it('refuses names that are not a single file name', async () => {
    for (const name of ['a/b', '..', '.', '', '  ', 'x\0y']) {
      expect(await status(files.op('work', { op: 'rename', path: '~/proj/README.md', name }))).toBe(400)
    }
  })

  it('never renames, moves or trashes a root or a folder holding one', async () => {
    expect(await status(files.op('work', { op: 'rename', path: '~/proj', name: 'x' }))).toBe(403)
    expect(await status(files.op('work', { op: 'trash', paths: ['~/notes'] }))).toBe(403)
    expect(await status(files.op('work', { op: 'move', paths: ['~/proj'], to: '~/work' }))).toBe(403)
    expect(spawned).toEqual([])
  })

  it('renames and trashes a symlink itself, not what it points to', async () => {
    await files.op('work', { op: 'rename', path: '~/proj/link-out', name: 'link2' })
    expect((await fsp.lstat(path.join(home, 'proj/link2'))).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(path.join(home, 'secret/key.txt'))).toBe(true)
    await files.op('work', { op: 'trash', paths: ['~/proj/link2'] })
    expect(spawned).toEqual([{ command: 'gio', args: ['trash', '--', path.join(fs.realpathSync(home), 'proj/link2')] }])
  })

  it('creates folders and empty files, never over an existing one', async () => {
    expect(await files.op('work', { op: 'mkdir', dir: '~/proj', name: 'New folder' })).toEqual({ path: '~/proj/New folder' })
    expect(fs.statSync(path.join(home, 'proj/New folder')).isDirectory()).toBe(true)
    expect(await files.op('work', { op: 'touch', dir: '~/proj', name: 'empty.md' })).toEqual({ path: '~/proj/empty.md' })
    expect(await fsp.readFile(path.join(home, 'proj/empty.md'), 'utf8')).toBe('')
    expect(await status(files.op('work', { op: 'touch', dir: '~/proj', name: 'README.md' }))).toBe(409)
    expect(await status(files.op('work', { op: 'mkdir', dir: '~/proj', name: 'sub' }))).toBe(409)
    expect(await status(files.op('work', { op: 'mkdir', dir: '~/secret', name: 'x' }))).toBe(403)
  })

  it('moves into a folder, skipping names that exist and moves into itself', async () => {
    await write('proj/sub/README.md', 'other\n')
    const result = await files.op('work', { op: 'move', paths: ['~/proj/notes.txt', '~/proj/README.md', '~/proj/src'], to: '~/proj/sub' })
    expect(result).toEqual({
      moved: [
        { from: '~/proj/notes.txt', to: '~/proj/sub/notes.txt' },
        { from: '~/proj/src', to: '~/proj/sub/src' },
      ],
      skipped: [{ path: '~/proj/README.md', reason: 'README.md already exists there' }],
    })
    expect(await fsp.readFile(path.join(home, 'proj/README.md'), 'utf8')).toBe('# Proj\n')
    const inner = await files.op('work', { op: 'move', paths: ['~/proj/sub'], to: '~/proj/sub/inner' })
    expect(inner).toMatchObject({ moved: [], skipped: [{ path: '~/proj/sub', reason: 'A folder cannot go inside itself' }] })
  })

  it('moves between roots of the same profile but not out of them', async () => {
    expect(await files.op('work', { op: 'move', paths: ['~/proj/notes.txt'], to: '~/work' })).toMatchObject({ moved: [{ to: '~/work/notes.txt' }] })
    expect(await status(files.op('work', { op: 'move', paths: ['~/work/notes.txt'], to: '~/secret' }))).toBe(403)
  })

  it('trashes with gio, never deleting itself', async () => {
    const result = await files.op('work', { op: 'trash', paths: ['~/proj/notes.txt', '~/proj/sub'] })
    expect(result).toEqual({ trashed: ['~/proj/notes.txt', '~/proj/sub'] })
    const real = fs.realpathSync(home)
    expect(spawned).toEqual([{ command: 'gio', args: ['trash', '--', `${real}/proj/notes.txt`, `${real}/proj/sub`] }])
    // The fake gio does nothing, so the files are still here.
    expect(fs.existsSync(path.join(home, 'proj/notes.txt'))).toBe(true)
  })

  it('reports a failing gio and deletes nothing', async () => {
    gioFails = 'gio: Trashing on system internal mounts is not supported'
    const err = await files.op('work', { op: 'trash', paths: ['~/proj/notes.txt'] }).catch((e) => e)
    expect(err.message).toContain('Trashing on system internal mounts is not supported')
    expect(fs.existsSync(path.join(home, 'proj/notes.txt'))).toBe(true)
  })
})

describe('opening in the default app', () => {
  it('opens files and folders with xdg-open', async () => {
    await files.open('work', '~/proj/logo.png')
    await files.open('work', '~/proj/src')
    const real = fs.realpathSync(home)
    expect(spawned.map((s) => [s.command, ...s.args])).toEqual([
      ['xdg-open', `${real}/proj/logo.png`],
      ['xdg-open', `${real}/proj/src`],
    ])
  })

  it('refuses launchers and executables', async () => {
    expect(await status(files.open('work', '~/proj/app.desktop'))).toBe(403)
    expect(await status(files.open('work', '~/proj/run.sh'))).toBe(403)
    expect(spawned).toEqual([])
  })
})

describe('tickets for media', () => {
  it('gives a short-lived URL for previewable files only', async () => {
    const { url } = await files.ticket('work', '~/proj/logo.png')
    expect(url).toMatch(/^\/raw\/[A-Za-z0-9_-]{32}\/logo\.png$/)
    const token = url.split('/')[2]
    expect(files.raw(token)).toMatchObject({ type: 'image/png', real: path.join(fs.realpathSync(home), 'proj/logo.png') })
    clock += 11 * 60 * 1000
    expect(files.raw(token)).toBeNull()
    expect(await status(files.ticket('work', '~/proj/notes.txt'))).toBe(415)
    expect(await status(files.ticket('work', '~/secret/key.txt'))).toBe(403)
    expect(files.raw('nope')).toBeNull()
  })
})

describe('watching', () => {
  it('reports a change in a listed folder', async () => {
    await files.list('work', '~/proj/src')
    const event = new Promise<{ path: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no files event')), 3000)
      files.on('files', (e) => {
        clearTimeout(t)
        resolve(e)
      })
    })
    await write('proj/src/new.py', '')
    expect(await event).toEqual({ path: '~/proj/src' })
  })
})

describe('HTTP routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }
  const q = (p: string) => encodeURIComponent(p)

  beforeEach(async () => {
    server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false, spawn: fakeSpawn as any })
  })

  afterEach(() => server.app.close())

  it('every files route needs the X-Workbench header', async () => {
    const bare = { host: '127.0.0.1:7420' }
    const gets = [`/api/files/list?profile=work&path=${q('~/proj')}`, `/api/files/text?profile=work&path=${q('~/proj/notes.txt')}`]
    for (const url of gets) expect((await server.app.inject({ method: 'GET', url, headers: bare })).statusCode).toBe(403)
    for (const [url, payload] of [
      ['/api/files/ticket', { profile: 'work', path: '~/proj/logo.png' }],
      ['/api/files/op', { profile: 'work', op: { op: 'trash', paths: ['~/proj/notes.txt'] } }],
      ['/api/files/open', { profile: 'work', path: '~/proj/logo.png' }],
    ] as const) {
      expect((await server.app.inject({ method: 'POST', url, headers: bare, payload })).statusCode).toBe(403)
    }
    expect(spawned).toEqual([])
  })

  it('lists, previews and runs operations', async () => {
    const list = await server.app.inject({ method: 'GET', url: `/api/files/list?profile=work&path=${q('~/proj/src')}`, headers })
    expect(list.json().entries).toHaveLength(3)
    const op = await server.app.inject({
      method: 'POST',
      url: '/api/files/op',
      headers,
      payload: { profile: 'work', op: { op: 'mkdir', dir: '~/proj', name: 'made' } },
    })
    expect(op.json()).toEqual({ path: '~/proj/made' })
    const bad = await server.app.inject({ method: 'POST', url: '/api/files/op', headers, payload: { profile: 'work', op: { op: 'explode' } } })
    expect(bad.statusCode).toBe(400)
  })

  it('serves a ticket with ranges, without the header but behind the Host check', async () => {
    const { url } = (
      await server.app.inject({ method: 'POST', url: '/api/files/ticket', headers, payload: { profile: 'work', path: '~/proj/song.mp3' } })
    ).json()
    const host = { host: '127.0.0.1:7420' }
    const full = await server.app.inject({ method: 'GET', url, headers: host })
    expect(full.statusCode).toBe(200)
    expect(full.headers['content-type']).toBe('audio/mpeg')
    expect(full.headers['x-content-type-options']).toBe('nosniff')
    const part = await server.app.inject({ method: 'GET', url, headers: { ...host, range: 'bytes=0-99' } })
    expect(part.statusCode).toBe(206)
    expect(part.rawPayload.length).toBe(100)
    expect((await server.app.inject({ method: 'GET', url, headers: { host: 'evil.test:7420' } })).statusCode).toBe(403)
    expect((await server.app.inject({ method: 'GET', url: '/raw/nope/x.mp3', headers: host })).statusCode).toBe(404)
  })

  it('sandboxes SVG', async () => {
    const { url } = (
      await server.app.inject({ method: 'POST', url: '/api/files/ticket', headers, payload: { profile: 'work', path: '~/proj/diagram.svg' } })
    ).json()
    const res = await server.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:7420' } })
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['content-security-policy']).toBe('sandbox')
  })
})
