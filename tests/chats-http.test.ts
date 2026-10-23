import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import type { Chat } from '../shared/config-schema.ts'
import { makeGuard } from '../server/guard.ts'
import { buildServer } from '../server/main.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

const WORK = `name: Work
workflow:
  - { label: agent, type: chat, args: [--model, opus] }
  - { label: shell, type: chat, agent: shell, path: src }
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha }
      - { label: Scratch, type: chat, path: ~/scratch }
      - { label: Docs, type: note, path: ~/alpha/README.md }
      - { label: Loose, type: item, id: abc12345, steps: [{ label: talk, type: chat }] }
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
let port: number

const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }
const rev = () => server.store.profile('work').rev

async function call<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers, payload })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

async function until<T>(fn: () => T | Promise<T>, what: string, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-chats-http-')))
  home = path.join(dir, 'home')
  await fsp.mkdir(path.join(home, 'alpha/src'), { recursive: true })
  await fsp.mkdir(path.join(home, 'scratch'), { recursive: true })
  await fsp.mkdir(path.join(home, 'elsewhere'), { recursive: true })
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
  })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('chat routes', { timeout: 15_000 }, () => {
  test('New chat in a project runs in its folder; a chat step and a chat entry use their slot', async () => {
    const adhoc = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    expect(adhoc.status).toBe(200)
    expect(adhoc.body).toMatchObject({ host: 'project:~/alpha', slot: null, agent: 'claude', cwd: '~/alpha', state: 'running' })
    // Alpha has no steps: of its own: All files and Claude setup come before the workflow.

    const step = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 2 })
    expect(step.body).toMatchObject({ host: 'project:~/alpha', slot: 'step:~/alpha|agent', cwd: '~/alpha' })
    const again = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 2 })
    expect(again.body.id).toBe(step.body.id)
    await until(() => server.chats.text(step.body.id).includes('args=["--model","opus"'), 'the step args')

    const shell = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 3 })
    expect(shell.body).toMatchObject({ agent: 'shell', cwd: '~/alpha/src', session: null })

    const entry = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 1 } })
    expect(entry.body).toMatchObject({ host: 'entry:~/scratch|Scratch', slot: 'entry:~/scratch|Scratch', cwd: '~/scratch' })

    const list = await call<Chat[]>('GET', '/api/chats?profile=work')
    expect(list.body.map((c) => c.id)).toEqual([adhoc.body.id, step.body.id, shell.body.id, entry.body.id])
  })

  test('an item without a folder: its chats run in home, keyed by its id; marks and servers skip it', async () => {
    const loose = { section: 0, index: 3 }
    const adhoc = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: loose })
    expect(adhoc.body).toMatchObject({ host: 'project:id:abc12345', slot: null, cwd: '~' })
    const step = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: loose, step: 0 })
    expect(step.body).toMatchObject({ host: 'project:id:abc12345', slot: 'step:id:abc12345|talk', cwd: '~' })
    expect((await call('GET', '/api/git/marks?profile=work')).status).toBe(200)
    expect((await call('GET', '/api/servers?profile=work')).status).toBe(200)
  })

  test('requests name entries, never commands; paths stay in the profile folders; resume takes only a session id', async () => {
    const at = { section: 0, index: 0 }
    expect((await call('POST', '/api/chats', { profile: 'work', rev: 'old', at })).status).toBe(409)
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 2 } })).status).toBe(422)
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), at, step: 7 })).status).toBe(404)
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), at, path: '~/elsewhere' })).status).toBe(403)
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), at, resume: '--dangerously-skip-permissions' })).status).toBe(400)
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), at, command: 'rm -rf ~' })).body.cwd).toBe('~/alpha')

    const here = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at, path: '~/alpha/src', agent: 'shell' })
    expect(here.body).toMatchObject({ cwd: '~/alpha/src', agent: 'shell', host: 'project:~/alpha' })
  })

  test('rename, colour, pin, close; colours come from the palette', async () => {
    const { body: chat } = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    const patched = await call<Chat>('PATCH', `/api/chats/${chat.id}`, { label: 'parser', color: '#8fa58a', pinned: true })
    expect(patched.body).toMatchObject({ label: 'parser', color: '#8fa58a', pinned: true })
    expect((await call('PATCH', `/api/chats/${chat.id}`, { color: 'red' })).status).toBe(400)
    expect((await call('POST', `/api/chats/${chat.id}/start`, {})).status).toBe(409)
    expect((await call('DELETE', `/api/chats/${chat.id}`)).status).toBe(200)
    expect((await call<Chat[]>('GET', '/api/chats?profile=work')).body).toEqual([])
    expect((await call('DELETE', `/api/chats/${chat.id}`)).status).toBe(404)
  })

  test('renaming a chat step in the app keeps its chat', async () => {
    const step = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 2 })
    const renamed = await call('POST', '/api/profiles/work/ops', {
      rev: rev(),
      ops: [{ op: 'updateStep', at: { section: 0, index: 0 }, index: 2, step: { label: 'claude', type: 'chat', args: ['--model', 'opus'] } }],
    })
    expect(renamed.status).toBe(200)
    expect(server.chats.get(step.body.id)?.slot).toBe('step:~/alpha|claude')
    const again = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 2 })
    expect(again.body.id).toBe(step.body.id)
  })

  test('History lists the Claude sessions in the project folder', async () => {
    const { body: chat } = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    server.chats.write(chat.id, 'plan the release\r')
    await until(() => server.chats.text(chat.id).includes('you said: plan the release'), 'the echo')
    const history = await call('GET', `/api/chats/history?profile=work&path=${encodeURIComponent('~/alpha')}`)
    expect(history.body).toEqual([expect.objectContaining({ id: chat.session, title: 'plan the release', cwd: '~/alpha' })])
    expect((await call('GET', `/api/chats/history?profile=work&path=${encodeURIComponent('~/elsewhere')}`)).status).toBe(403)
  })
})

describe('chat terminal socket', { timeout: 15_000 }, () => {
  let chat: Chat
  let token: string

  beforeEach(async () => {
    await server.app.listen({ host: '127.0.0.1', port: 0 })
    port = (server.app.server.address() as { port: number }).port
    chat = (await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })).body
    token = (await call<{ token: string }>('GET', '/api/chats/token')).body.token
  })

  // The guard was built for port 7420; the socket tests listen on a free port, so
  // they send the Host and Origin the guard expects.
  const open = (protocols: string[], origin = 'http://127.0.0.1:7420') =>
    new WebSocket(`ws://127.0.0.1:${port}/pty/${chat.id}?cols=90&rows=20`, protocols, { headers: { host: '127.0.0.1:7420', origin } })

  const outcome = (ws: WebSocket) =>
    new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      // With this listener ws leaves the refused request open for us to end.
      ws.on('unexpected-response', (req, res) => {
        req.destroy()
        resolve(`refused ${res.statusCode}`)
      })
      ws.on('error', () => resolve('error'))
    })

  test('is refused without the token, with a wrong one, or from another origin', async () => {
    expect(await outcome(open(['workbench']))).toBe('refused 403')
    expect(await outcome(open(['workbench', `wb.${'0'.repeat(64)}`]))).toBe('refused 403')
    expect(await outcome(open(['workbench', `wb.${token}`], 'https://evil.test'))).toBe('refused 403')
  })

  test('with the token: the screen, then output; typing reaches the program; the size follows the view', async () => {
    const ws = open(['workbench', `wb.${token}`])
    const frames: string[] = []
    ws.on('message', (m) => frames.push(m.toString()))
    expect(await outcome(ws)).toBe('open')
    expect(ws.protocol).toBe('workbench')
    await until(() => frames.join('').includes('FAKE CLAUDE'), 'the screen')
    expect(frames[0].startsWith('r')).toBe(true)
    ws.send('ihello socket\r')
    await until(() => frames.some((f) => f.startsWith('o') && f.includes('you said: hello socket')), 'the echo')
    // The args line (with the session hook's --settings) is longer than any width.
    await until(() => server.chats.text(chat.id).split('\n').every((l) => l.length <= 90 || l.startsWith('args=')), 'the size')
    ws.close()
  })

  test('the guard wants an Origin on the socket', () => {
    const check = makeGuard([7420])
    expect(check({ host: '127.0.0.1:7420' }, '/pty/x')).toMatch(/Origin/)
    expect(check({ host: '127.0.0.1:7420', origin: 'http://127.0.0.1:7420' }, '/pty/x')).toBeNull()
  })
})
