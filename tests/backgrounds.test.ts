import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps } from '../server/config-ops.ts'
import { buildServer } from '../server/main.ts'
import { Profile } from '../shared/config-schema.ts'

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const WORK = `name: Work
home: ~/stuff
# The look
accent: "#7d93ab"
sections: []
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

async function call<T = any>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object): Promise<{ status: number; body: T; raw: Buffer; type?: string }> {
  const res = await server.app.inject({ method, url, headers, payload })
  const type = res.headers['content-type'] as string | undefined
  return { status: res.statusCode, body: type?.includes('json') ? JSON.parse(res.body) : undefined, raw: res.rawPayload, type }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-bg-')))
  home = path.join(dir, 'home')
  await fsp.mkdir(path.join(home, 'stuff/pics'), { recursive: true })
  await fsp.mkdir(path.join(home, 'elsewhere'), { recursive: true })
  await fsp.writeFile(path.join(home, 'stuff/pics/Lake view.png'), PNG)
  await fsp.writeFile(path.join(home, 'stuff/pics/other.png'), Buffer.concat([PNG, Buffer.from('x')]))
  await fsp.writeFile(path.join(home, 'stuff/pics/logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await fsp.writeFile(path.join(home, 'stuff/pics/notes.txt'), 'not a picture')
  await fsp.writeFile(path.join(home, 'elsewhere/secret.png'), PNG)
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state') })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('theme and background in the profile', () => {
  const run = (source: string, key: 'theme' | 'background', value: string) => {
    const doc = parseDocument(source)
    applyOps(doc, [{ op: 'setProfileField', key, value }], source)
    return doc.toString()
  }

  it('are set after the accent, keep comments, and are removed by an empty value', () => {
    const text = run(run(WORK, 'theme', 'fjord'), 'background', 'lake.png')
    expect(text).toContain('# The look\naccent: "#7d93ab"\ntheme: fjord\nbackground: lake.png\nsections:')
    expect(run(text, 'theme', '')).not.toContain('theme:')
    expect(Profile.parse(parseDocument(text).toJS())).toMatchObject({ theme: 'fjord', background: 'lake.png' })
  })
})

describe('background pictures', () => {
  it('copies a picture from the profile’s folders, under a safe and unique name', async () => {
    const first = await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/Lake view.png' })
    expect(first).toMatchObject({ status: 200, body: { name: 'Lake-view.png' } })
    expect(await fsp.readFile(path.join(dir, 'cfg/backgrounds/Lake-view.png'))).toEqual(PNG)
    // The same picture again is the same file; a different one with the same name gets a number.
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/Lake view.png' })).body).toEqual({ name: 'Lake-view.png' })
    await fsp.copyFile(path.join(home, 'stuff/pics/other.png'), path.join(home, 'stuff/pics/Lake view.png'))
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/Lake view.png' })).body).toEqual({ name: 'Lake-view-2.png' })
    expect((await call<string[]>('GET', '/api/backgrounds')).body).toEqual(['Lake-view-2.png', 'Lake-view.png'])
  })

  it('refuses pictures outside the profile’s folders, SVG and other files', async () => {
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/elsewhere/secret.png' })).status).toBe(403)
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/logo.svg' })).status).toBe(415)
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/notes.txt' })).status).toBe(415)
    expect((await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/missing.png' })).status).toBe(404)
  })

  it('serves only the pictures in the folder, by plain name', async () => {
    await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/Lake view.png' })
    const pic = await call('GET', '/api/backgrounds/Lake-view.png')
    expect(pic.status).toBe(200)
    expect(pic.type).toBe('image/png')
    expect(pic.raw).toEqual(PNG)
    await fsp.writeFile(path.join(dir, 'cfg/settings.yaml'), 'profiles: []\n')
    expect((await call('GET', `/api/backgrounds/${encodeURIComponent('../settings.yaml')}`)).status).toBe(404)
    expect((await call('GET', '/api/backgrounds/settings.yaml')).status).toBe(404)
    expect((await call('GET', '/api/backgrounds/nope.png')).status).toBe(404)
    const bare = await server.app.inject({ method: 'GET', url: '/api/backgrounds/Lake-view.png', headers: { host: '127.0.0.1:7420' } })
    expect(bare.statusCode).toBe(403)
  })

  it('deletes a picture from the folder', async () => {
    await call('POST', '/api/backgrounds', { profile: 'work', path: '~/stuff/pics/Lake view.png' })
    expect((await call('DELETE', '/api/backgrounds/Lake-view.png')).status).toBe(200)
    expect((await call<string[]>('GET', '/api/backgrounds')).body).toEqual([])
    expect((await call('DELETE', '/api/backgrounds/Lake-view.png')).status).toBe(404)
  })
})
