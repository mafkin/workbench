import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Profile } from '../shared/config-schema.ts'
import { buildServer } from '../server/main.ts'
import { openProgram } from '../server/open-with.ts'

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
let spawned: { command: string; args: string[]; cwd?: string }[]
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

/** Programs "installed": only these are found. */
const installed = (names: string[]) => (name: string) => (names.includes(name) ? `/usr/bin/${name}` : null)

function fakeSpawn(command: string, args: string[], options: { cwd?: string } = {}) {
  spawned.push({ command, args, cwd: options.cwd })
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => child.emit('spawn'))
  return child
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-open-')))
  home = path.join(dir, 'home')
  spawned = []
  for (const d of ['art/game/scenes', 'art/models/tex', 'outside']) await fsp.mkdir(path.join(home, d), { recursive: true })
  await fsp.writeFile(path.join(home, 'art/ship.blend'), 'b')
  await fsp.writeFile(path.join(home, 'art/ship.blend1'), 'b')
  await fsp.writeFile(path.join(home, 'art/sketch.kra'), 'k')
  await fsp.writeFile(path.join(home, 'art/game/project.godot'), '[application]\n')
  await fsp.writeFile(path.join(home, 'art/game/scenes/main.tscn'), 's')
  await fsp.writeFile(path.join(home, 'art/models/ship.gltf'), '{}')
  await fsp.writeFile(path.join(home, 'art/models/ship.bin'), 'bin')
  await fsp.writeFile(path.join(home, 'art/models/tex/hull.png'), 'png')
  await fsp.writeFile(path.join(home, 'art/readme.txt'), 't')
  await fsp.writeFile(path.join(home, 'outside/secret.txt'), 'secret')
  await fsp.symlink(path.join(home, 'outside/secret.txt'), path.join(home, 'art/models/escape.png'))
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'cfg/profiles/work.yaml'),
    'name: Work\nopenWith:\n  - { ext: [kra, .ORA], command: krita }\nsections:\n  - title: Projects\n    items:\n      - { label: Art, type: folder, path: ~/art }\n',
  )
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), gitFetchEveryMs: 0, spawn: fakeSpawn as never, thumbsDir: path.join(dir, 'thumbs') })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('open with', () => {
  const profile = () => Profile.parse({ name: 'Work', sections: [], openWith: [{ ext: ['kra', '.ORA'], command: 'krita' }, { ext: ['blend'], command: '~/bin/blender-4', label: 'Blender 4' }] })

  it('uses your rules first, then Blender and Godot when they are installed', async () => {
    const find = installed(['blender', 'godot'])
    const art = path.join(home, 'art')
    expect(await openProgram(profile(), path.join(art, 'sketch.kra'), home, find)).toEqual({ label: 'Krita', command: 'krita', args: [path.join(art, 'sketch.kra')], cwd: art })
    expect(await openProgram(profile(), path.join(art, 'ship.blend'), home, find)).toMatchObject({ label: 'Blender 4', command: path.join(home, 'bin/blender-4') })
    const plain = Profile.parse({ name: 'Work', sections: [] })
    expect(await openProgram(plain, path.join(art, 'ship.blend1'), home, find)).toEqual({ label: 'Blender', command: '/usr/bin/blender', args: [path.join(art, 'ship.blend1')], cwd: art })
    const game = path.join(art, 'game')
    expect(await openProgram(plain, path.join(game, 'scenes/main.tscn'), home, find)).toEqual({ label: 'Godot', command: '/usr/bin/godot', args: ['--editor', '--path', game], cwd: game })
    expect(await openProgram(plain, game, home, find)).toMatchObject({ label: 'Godot', args: ['--editor', '--path', game] })
    expect(await openProgram(plain, path.join(art, 'readme.txt'), home, find)).toBeNull()
    expect(await openProgram(plain, path.join(art, 'ship.blend'), home, installed([]))).toBeNull()
  })

  it('starts the program for a file of the profile, detached and without a shell; the request names only the file', async () => {
    const label = await server.app.inject({ method: 'GET', url: '/api/files/open-with?profile=work&path=~/art/sketch.kra', headers })
    expect(JSON.parse(label.body)).toEqual({ label: 'Krita' })
    const res = await server.app.inject({ method: 'POST', url: '/api/files/open-with', headers, payload: { profile: 'work', path: '~/art/sketch.kra', command: 'rm', args: ['-rf', '/'] } })
    expect(res.statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'krita', args: [path.join(home, 'art/sketch.kra')], cwd: path.join(home, 'art') }])
    expect((await server.app.inject({ method: 'POST', url: '/api/files/open-with', headers, payload: { profile: 'work', path: '~/art/readme.txt' } })).statusCode).toBe(422)
    expect((await server.app.inject({ method: 'POST', url: '/api/files/open-with', headers, payload: { profile: 'work', path: '~/outside/secret.txt' } })).statusCode).toBe(403)
  })

  it('a 3D model’s folder ticket serves the files beside it, and nothing outside', async () => {
    const t = await server.app.inject({ method: 'POST', url: '/api/files/ticket', headers, payload: { profile: 'work', path: '~/art/models/ship.gltf', folder: true } })
    expect(t.statusCode).toBe(200)
    const { url } = JSON.parse(t.body) as { url: string }
    const base = url.slice(0, url.lastIndexOf('/') + 1)
    const fetchRaw = (rel: string) => server.app.inject({ method: 'GET', url: base + rel, headers: { host: headers.host } })
    expect((await fetchRaw('ship.bin')).body).toBe('bin')
    expect((await fetchRaw('tex/hull.png')).body).toBe('png')
    expect((await fetchRaw('..%2F..%2Foutside%2Fsecret.txt')).statusCode).toBe(404)
    expect((await fetchRaw('escape.png')).statusCode).toBe(404)
    const txt = await server.app.inject({ method: 'POST', url: '/api/files/ticket', headers, payload: { profile: 'work', path: '~/art/readme.txt', folder: true } })
    expect(txt.statusCode).toBe(415)
  })
})
