import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server/main.ts'
import { migrateFixture } from './fixtures/wiki.ts'

const WORK = `name: Work
sections:
  - title: Work
    items:
      - { label: Work, type: folder, path: ~/work }
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

/** gio trash as GNOME does it: into the home Trash, with a .trashinfo naming where it was. */
function fakeSpawn(command: string, args: string[]) {
  if (command === 'gio' && args[0] === 'trash') {
    const trash = path.join(home, '.local/share/Trash')
    fs.mkdirSync(path.join(trash, 'files'), { recursive: true })
    fs.mkdirSync(path.join(trash, 'info'), { recursive: true })
    for (const p of args.slice(2)) {
      let name = path.basename(p)
      for (let n = 2; fs.existsSync(path.join(trash, 'files', name)); n++) name = `${path.basename(p)}.${n}`
      fs.renameSync(p, path.join(trash, 'files', name))
      fs.writeFileSync(path.join(trash, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(p)}\nDeletionDate=2026-10-22T10:00:0${n0++}\n`)
    }
  }
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => {
    child.emit('spawn')
    child.emit('close', 0)
  })
  return child
}
let n0 = 0

async function write(rel: string, data: string) {
  const file = path.join(home, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
  return file
}

const op = (body: object) => server.app.inject({ method: 'POST', url: '/api/files/op', headers, payload: { profile: 'work', op: body } })
const get = (url: string) => server.app.inject({ method: 'GET', url, headers })
const q = encodeURIComponent

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-files2-')))
  home = path.join(dir, 'home')
  n0 = 0
  await write('work/a.txt', 'aaa')
  await write('work/sub/b.txt', 'bbbbb')
  await write('work/sub/deep/c.md', 'c')
  await write('work/.hidden/needle.txt', 'x')
  await write('work/node_modules/pkg/needle.js', 'x')
  await write('work/sub/needle notes.md', 'x')
  await write('elsewhere/x.txt', 'x')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  await migrateFixture(path.join(dir, 'cfg'), home)
  server = await buildServer({ dir: path.join(home, 'wb'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), spawn: fakeSpawn as any })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('copy and duplicate', () => {
  it('copies files and folders under a free name; a copy into the same folder is a duplicate', async () => {
    let res = await op({ op: 'copy', paths: ['~/work/a.txt', '~/work/sub'], to: '~/work/sub/deep' })
    expect(res.json()).toEqual({ copied: [{ from: '~/work/a.txt', to: '~/work/sub/deep/a.txt' }], skipped: [{ path: '~/work/sub', reason: 'A folder cannot go inside itself' }] })
    res = await op({ op: 'copy', paths: ['~/work/a.txt', '~/work/a.txt', '~/work/sub'], to: '~/work' })
    expect(res.json().copied.map((c: { to: string }) => c.to)).toEqual(['~/work/a copy.txt', '~/work/a copy 2.txt', '~/work/sub copy'])
    expect(await fsp.readFile(path.join(home, 'work/sub copy/deep/c.md'), 'utf8')).toBe('c')
    expect(await fsp.readFile(path.join(home, 'work/a.txt'), 'utf8')).toBe('aaa')
  })

  it('stays in the profile’s folders', async () => {
    expect((await op({ op: 'copy', paths: ['~/elsewhere/x.txt'], to: '~/work' })).statusCode).toBe(403)
    expect((await op({ op: 'copy', paths: ['~/work/a.txt'], to: '~/elsewhere' })).statusCode).toBe(403)
  })
})

describe('Trash with Undo', () => {
  it('puts trashed files back where they were', async () => {
    expect((await op({ op: 'trash', paths: ['~/work/a.txt', '~/work/sub/deep'] })).statusCode).toBe(200)
    expect(fs.existsSync(path.join(home, 'work/a.txt'))).toBe(false)
    const res = await op({ op: 'restore', paths: ['~/work/a.txt', '~/work/sub/deep'] })
    expect(res.json()).toEqual({ restored: ['~/work/a.txt', '~/work/sub/deep'], skipped: [] })
    expect(await fsp.readFile(path.join(home, 'work/sub/deep/c.md'), 'utf8')).toBe('c')
    expect(await fsp.readdir(path.join(home, '.local/share/Trash/info'))).toEqual([])
  })

  it('takes the newest one, and leaves it in the Trash when its place is taken', async () => {
    await op({ op: 'trash', paths: ['~/work/a.txt'] })
    await write('work/a.txt', 'second')
    await op({ op: 'trash', paths: ['~/work/a.txt'] })
    await write('work/a.txt', 'third')
    expect((await op({ op: 'restore', paths: ['~/work/a.txt'] })).json()).toEqual({ restored: [], skipped: [{ path: '~/work/a.txt', reason: 'Something else is there now; it stays in the Trash' }] })
    await fsp.rm(path.join(home, 'work/a.txt'))
    await op({ op: 'restore', paths: ['~/work/a.txt'] })
    expect(await fsp.readFile(path.join(home, 'work/a.txt'), 'utf8')).toBe('second')
  })
})

describe('folder sizes and search', () => {
  it('adds up a folder', async () => {
    const res = await get(`/api/files/size?profile=work&path=${q('~/work/sub')}`)
    expect(res.json()).toEqual({ bytes: 5 + 1 + 1, files: 3, complete: true })
  })

  it('finds names in closed folders, skipping dotfolders, .git and node_modules unless hidden ones are shown', async () => {
    const res = await get(`/api/files/find?profile=work&path=${q('~/work')}&q=NEEDLE`)
    expect(res.json()).toMatchObject({ complete: true, hits: [expect.objectContaining({ path: '~/work/sub/needle notes.md', kind: 'file', name: 'needle notes.md' })] })
    const hidden = await get(`/api/files/find?profile=work&path=${q('~/work')}&q=needle&hidden=1`)
    expect(hidden.json().hits.map((h: { path: string }) => h.path).sort()).toEqual(['~/work/.hidden/needle.txt', '~/work/sub/needle notes.md'])
    expect((await get(`/api/files/find?profile=work&path=${q('~/elsewhere')}&q=x`)).statusCode).toBe(403)
  })
})

describe('upload', () => {
  const upload = (dirPath: string, name: string, body: string) =>
    server.app.inject({ method: 'POST', url: `/api/files/upload?profile=work&dir=${q(dirPath)}&name=${q(name)}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: body })

  it('writes a dropped file into the folder, never over another', async () => {
    expect((await upload('~/work', 'new.txt', 'hello')).json()).toEqual({ path: '~/work/new.txt' })
    expect((await upload('~/work', 'new.txt', 'again')).json()).toEqual({ path: '~/work/new 2.txt' })
    expect(await fsp.readFile(path.join(home, 'work/new.txt'), 'utf8')).toBe('hello')
    expect(await fsp.readFile(path.join(home, 'work/new 2.txt'), 'utf8')).toBe('again')
    expect((await fsp.readdir(path.join(home, 'work'))).filter((f) => f.includes('wb-upload'))).toEqual([])
  })

  it('refuses other folders and odd names', async () => {
    expect((await upload('~/elsewhere', 'x.txt', 'x')).statusCode).toBe(403)
    expect((await upload('~/work', '../x.txt', 'x')).statusCode).toBe(400)
  })
})
