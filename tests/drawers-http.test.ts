import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Chat } from '../shared/config-schema.ts'
import { buildServer } from '../server/main.ts'
import { encodePng } from '../server/thumbs.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

const WORK = `name: Work
notes: ~/notes
drawers:
  - name: Game dev
    folder: ~/shared/game
    uses: [Research, Nowhere]
    sections:
      - title: Projects
        items:
          - { label: Tower, type: folder, path: ~/tower }
  - name: Research
    folder: ~/shared/research
    sections:
      - title: Projects
        items:
          - { label: Tower, type: shared, drawer: Game dev, path: ~/tower }
          - { label: Lab, type: folder, path: ~/lab }
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>

const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }
const rev = () => server.store.profile('work').rev

async function call<T = any>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, type?: string): Promise<{ status: number; body: T; raw: Buffer }> {
  const res = await server.app.inject({ method, url, headers: type ? { ...headers, 'content-type': type } : headers, payload })
  const json = res.headers['content-type']?.toString().startsWith('application/json')
  return { status: res.statusCode, body: json ? JSON.parse(res.body) : (undefined as T), raw: res.rawPayload }
}

const start = (at: object) => call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at })

async function sees(id: string, text: string, timeout = 5000) {
  const end = Date.now() + timeout
  while (!server.chats.text(id).includes(text)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for "${text}" in:\n${server.chats.text(id)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-drawers-http-')))
  home = path.join(dir, 'home')
  for (const d of ['tower', 'lab', 'notes', 'shared/game', 'shared/research']) await fsp.mkdir(path.join(home, d), { recursive: true })
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  server = await buildServer({
    configDir: path.join(dir, 'cfg'),
    port: 7420,
    distDir: null,
    home,
    watch: false,
    stateDir: path.join(dir, 'state'),
    chatCommands: { claude: FAKE_CLAUDE, shell: FAKE_SHELL },
    gitFetchEveryMs: 0,
  })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('drawers in the service', { timeout: 15_000 }, () => {
  test("a chat in a drawer gets its own and its used drawers' shared folders in one --add-dir", async () => {
    const { body: chat } = await start({ section: 0, index: 0 })
    const game = path.join(home, 'shared/game')
    const research = path.join(home, 'shared/research')
    await sees(chat.id, `"--add-dir","${game}","${research}","--session-id"`)
    expect(server.chats.text(chat.id)).toContain('# Shared folders (Workbench, drawer Game dev)')
  })

  test("a shared entry starts its original's chat, with the original drawer's folders", async () => {
    const { body: chat } = await start({ drawer: 1, section: 0, index: 0 })
    expect(chat).toMatchObject({ host: 'project:~/tower' })
    await sees(chat.id, `"--add-dir","${path.join(home, 'shared/game')}","${path.join(home, 'shared/research')}"`)
    // Research uses nothing: its own project gets only its own folder.
    const { body: lab } = await start({ drawer: 1, section: 0, index: 1 })
    await sees(lab.id, `"--add-dir","${path.join(home, 'shared/research')}","--session-id"`)
  })

  test('the file routes may open drawer folders', async () => {
    const res = await call('GET', `/api/files/list?profile=work&path=${encodeURIComponent('~/shared/research')}`)
    expect(res.status).toBe(200)
  })

  test('logos: a 64×64 PNG is kept by its content; others are refused', async () => {
    const png = encodePng(64, 64, Buffer.alloc(64 * 64 * 4, 0x80))
    const put = await call<{ name: string }>('PUT', '/api/logos', png, 'image/png')
    expect(put.status).toBe(200)
    expect(put.body.name).toMatch(/^[0-9a-f]{12}\.png$/)
    expect((await call('PUT', '/api/logos', png, 'image/png')).body).toEqual(put.body)
    const got = await call('GET', `/api/logos/${put.body.name}`)
    expect(got.status).toBe(200)
    expect(got.raw.equals(png)).toBe(true)

    expect((await call('PUT', '/api/logos', encodePng(65, 64, Buffer.alloc(65 * 64 * 4)), 'image/png')).status).toBe(422)
    expect((await call('PUT', '/api/logos', Buffer.from('RIFF0000WEBPVP8 '), 'image/webp')).status).toBe(415)
    expect((await call('GET', '/api/logos/..%2Fprofiles%2Fwork.yaml')).status).toBe(404)
  })

  test('a drawer folder in one click: <notes>/drawers/<name>', async () => {
    const res = await call<{ folder: string }>('POST', '/api/drawers/folder', { profile: 'work', name: 'Game dev' })
    expect(res.body).toEqual({ folder: '~/notes/drawers/game-dev' })
    expect((await fsp.stat(path.join(home, 'notes/drawers/game-dev'))).isDirectory()).toBe(true)
    // Only a drawer name: no paths.
    expect((await call('POST', '/api/drawers/folder', { profile: 'work', name: '../../etc' })).body).toEqual({ folder: '~/notes/drawers/etc' })
    expect((await call('POST', '/api/drawers/folder', { profile: 'work', name: '' })).status).toBe(400)
  })
})
