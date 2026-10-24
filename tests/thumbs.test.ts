import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server/main.ts'
import { Thumbs } from '../server/thumbs.ts'
import { migrateFixture } from './fixtures/wiki.ts'

let dir: string
let home: string
let thumbsDir: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

/** A minimal WebP, as far as the magic bytes go. */
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(12, 1)])

const get = (p: string) => server.app.inject({ method: 'GET', url: `/api/thumbs?profile=work&path=${encodeURIComponent(p)}`, headers })
const put = (p: string, body: Buffer, type = 'image/webp') =>
  server.app.inject({ method: 'PUT', url: `/api/thumbs?profile=work&path=${encodeURIComponent(p)}`, headers: { ...headers, 'content-type': type }, payload: body })

/** A classic little-endian .blend with a 1×1 preview. */
function blend(): Buffer {
  const i32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32LE(n)
    return b
  }
  const block = (code: string, data: Buffer) => Buffer.concat([Buffer.from(code), i32(data.length), Buffer.alloc(8), i32(0), i32(1), data])
  return zlib.zstdCompressSync(Buffer.concat([Buffer.from('BLENDER-v405'), block('TEST', Buffer.concat([i32(1), i32(1), Buffer.from([10, 20, 30, 255])])), block('ENDB', Buffer.alloc(0))]))
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-thumbs-')))
  home = path.join(dir, 'home')
  thumbsDir = path.join(dir, 'cache/thumbs')
  await fsp.mkdir(path.join(home, 'art/game/sprites'), { recursive: true })
  await fsp.mkdir(path.join(home, 'outside'), { recursive: true })
  await fsp.writeFile(path.join(home, 'art/hero.png'), 'png bytes')
  await fsp.writeFile(path.join(home, 'art/ship.glb'), 'glb bytes')
  await fsp.writeFile(path.join(home, 'art/theme.ogg'), 'ogg bytes')
  await fsp.writeFile(path.join(home, 'art/notes.txt'), 'text')
  await fsp.writeFile(path.join(home, 'art/scene.blend'), blend())
  await fsp.writeFile(path.join(home, 'art/game/project.godot'), '[application]\nconfig/name="Game"\nconfig/icon="res://sprites/icon.png"\n')
  await fsp.writeFile(path.join(home, 'art/game/sprites/icon.png'), 'icon')
  await fsp.writeFile(path.join(home, 'outside/secret.png'), 'no')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), 'name: Work\nsections:\n  - title: Projects\n    items:\n      - { label: Art, type: folder, path: ~/art }\n')
  await migrateFixture(path.join(dir, 'cfg'), home)
  server = await buildServer({ dir: path.join(home, 'wb'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), gitFetchEveryMs: 0, thumbsDir })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('gallery thumbnails', () => {
  it('say what to make one from, keep the one the browser made, and drop it when the file changes', async () => {
    expect(JSON.parse((await get('~/art/hero.png')).body)).toMatchObject({ make: 'image' })
    expect(JSON.parse((await get('~/art/ship.glb')).body)).toMatchObject({ make: 'model' })
    expect(JSON.parse((await get('~/art/theme.ogg')).body)).toMatchObject({ make: 'audio' })
    expect(JSON.parse((await get('~/art/notes.txt')).body)).toMatchObject({ make: null })

    expect((await put('~/art/hero.png', WEBP)).statusCode).toBe(200)
    const hit = await get('~/art/hero.png')
    expect(hit.statusCode).toBe(200)
    expect(hit.headers['content-type']).toBe('image/webp')
    expect(hit.rawPayload.equals(WEBP)).toBe(true)
    expect(fs.readdirSync(thumbsDir)).toHaveLength(1)

    const later = new Date(Date.now() + 5000)
    await fsp.utimes(path.join(home, 'art/hero.png'), later, later)
    expect((await get('~/art/hero.png')).statusCode).toBe(404)
  })

  it('make a .blend thumbnail from its own preview, and point a Godot project at its icon', async () => {
    const res = await get('~/art/scene.blend')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG')
    expect(JSON.parse((await get('~/art/game')).body)).toMatchObject({ make: 'image', source: '~/art/game/sprites/icon.png' })
    expect(JSON.parse((await get('~/art')).body)).toMatchObject({ make: null })
  })

  it('refuse anything but a small WebP or PNG, and files outside the profile', async () => {
    expect((await put('~/art/hero.png', Buffer.from('<svg onload=alert(1)>'), 'image/png')).statusCode).toBe(415)
    expect((await put('~/art/hero.png', Buffer.concat([WEBP, Buffer.alloc(520 * 1024)]))).statusCode).toBe(413)
    expect((await put('~/outside/secret.png', WEBP)).statusCode).toBe(403)
    expect((await get('~/outside/secret.png')).statusCode).toBe(403)
    const plain = await server.app.inject({ method: 'PUT', url: '/api/thumbs?profile=work&path=~/art/hero.png', headers: { host: headers.host, 'content-type': 'image/webp' }, payload: WEBP })
    expect(plain.statusCode).toBe(403)
  })

  it('prune the least recently used past the cap', async () => {
    const t = new Thumbs(path.join(dir, 'small'), { maxBytes: 1000 })
    const thumb: Record<string, string> = {}
    // a is made first and d last, a minute apart; then a is looked at again.
    for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) {
      const file = path.join(home, 'art', `${name}.png`)
      await fsp.writeFile(file, name)
      await t.put(file, Buffer.concat([WEBP, Buffer.alloc(300)]))
      thumb[name] = `${t.key(file, fs.statSync(file))}.webp`
      const made = new Date(Date.now() - (4 - i) * 60_000)
      await fsp.utimes(path.join(t.dir, thumb[name]), made, made)
    }
    expect(await t.get(path.join(home, 'art/a.png'), (p) => p)).toMatchObject({ type: 'image/webp' })
    // Four of about 340 bytes is past 1000; the two least recently used go, down to 80%.
    expect(await t.prune()).toBe(2)
    expect(fs.readdirSync(t.dir).sort()).toEqual([thumb.a, thumb.d].sort())
  })
})
