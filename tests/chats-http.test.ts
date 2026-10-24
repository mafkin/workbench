import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import WebSocket from 'ws'
import type { Chat } from '../shared/config-schema.ts'
import { makeGuard } from '../server/guard.ts'
import { buildServer } from '../server/main.ts'
import { migrateFixture } from './fixtures/wiki.ts'

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
  await migrateFixture(path.join(dir, 'cfg'), home, { defaultWiki: (id) => path.join(dir, 'wiki', id) })
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
    // Alpha has no steps: of its own: All files comes before the workflow.

    const step = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 1 })
    expect(step.body).toMatchObject({ host: 'project:~/alpha', slot: 'step:~/alpha|agent', cwd: '~/alpha' })
    const again = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 1 })
    expect(again.body.id).toBe(step.body.id)
    await until(() => server.chats.text(step.body.id).includes('args=["--model","opus"'), 'the step args')

    const shell = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 2 })
    expect(shell.body).toMatchObject({ agent: 'shell', cwd: '~/alpha/src', session: null })

    const entry = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 1 } })
    expect(entry.body).toMatchObject({ host: 'entry:~/scratch|Scratch', slot: 'entry:~/scratch|Scratch', cwd: '~/scratch' })

    const list = await call<Chat[]>('GET', '/api/chats?profile=work')
    expect(list.body.map((c) => c.id)).toEqual([adhoc.body.id, step.body.id, shell.body.id, entry.body.id])
  })

  test('a chat gets the pinned skills: named in the prompt, the wiki’s own through --plugin-dir; a shell gets none', async () => {
    const wiki = path.join(dir, 'wiki/work')
    await fsp.mkdir(path.join(wiki, 'skills/concept-art'), { recursive: true })
    await fsp.writeFile(path.join(wiki, 'skills/concept-art/SKILL.md'), '---\ndescription: Prompts for concept art\n---\n# Concept art\n')
    await fsp.mkdir(path.join(home, '.claude/skills/deploy'), { recursive: true })
    await fsp.writeFile(path.join(home, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ships it\n---\n')
    await server.store.apply('work', rev(), [
      { op: 'setSkills', names: ['deploy', 'nope'] },
      { op: 'setSkills', at: { section: 0, index: 0 }, names: ['concept-art'] },
    ])
    const setup = await call('GET', '/api/claude/setup?profile=work&path=~/alpha')
    expect(setup.body.pinned).toEqual({ profile: ['deploy', 'nope'], drawer: ['deploy', 'nope'], page: ['concept-art'], missing: ['nope'] })
    expect(setup.body.skills.find((s: { scope: string; name: string }) => s.scope === 'wiki' && s.name === 'concept-art')).toBeTruthy()

    const chat = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    expect(chat.status, JSON.stringify(chat.body)).toBe(200)
    const saved = await until(async () => {
      const list = JSON.parse(await fsp.readFile(path.join(dir, 'state/chats.json'), 'utf8').catch(() => '{}')).chats ?? []
      return list.find((c: { id: string }) => c.id === chat.body.id)
    }, 'the saved chat')
    const args: string[] = saved.args
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain('# Pinned skills (Workbench)')
    expect(prompt).toContain('- /deploy: Ships it')
    expect(prompt).toContain('- /wiki:concept-art: Prompts for concept art')
    expect(prompt).not.toContain('nope')
    const plugin = args[args.indexOf('--plugin-dir') + 1]
    expect(plugin).toMatch(new RegExp(`^${path.join(dir, 'state/skills')}/[0-9a-f]{16}/wiki$`))
    expect(await fsp.readlink(path.join(plugin, 'skills/concept-art'))).toBe(path.join(wiki, 'skills/concept-art'))
    // The plugin flag comes before the list flags, which the session id ends.
    expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--add-dir'))

    const shell = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, agent: 'shell' })
    const shellSaved = await until(async () => {
      const list = JSON.parse(await fsp.readFile(path.join(dir, 'state/chats.json'), 'utf8').catch(() => '{}')).chats ?? []
      return list.find((c: { id: string }) => c.id === shell.body.id)
    }, 'the saved shell')
    expect(shellSaved.args).not.toContain('--plugin-dir')
  })

  test('a chat from a page remembers it and gets its text; a drawer’s own chat runs in its folder', async () => {
    const wiki = path.join(dir, 'wiki/work')
    await fsp.writeFile(path.join(wiki, 'pages/Alpha.md'), '---\nfolder: ~/alpha\n---\n# Alpha\n\nA small pig. A very big sky.\n\n## Workflow\n\n- [All files](files:)\n')
    // No watcher in tests: the store notices the hand edit on the next apply (which it refuses, as stale).
    await server.store.apply('work', rev(), []).catch(() => {})
    await server.store.apply('work', rev(), [{ op: 'setDrawer', drawer: 0, field: 'folder', value: '~/scratch' }])
    const chat = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    expect(chat.body.page).toBe('pages/Alpha.md')
    const saved = await until(async () => {
      const list = JSON.parse(await fsp.readFile(path.join(dir, 'state/chats.json'), 'utf8').catch(() => '{}')).chats ?? []
      return list.find((c: { id: string }) => c.id === chat.body.id)
    }, 'the saved chat')
    const prompt: string = saved.args[saved.args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain('## The page I am looking at\n\n# Alpha\n\nA small pig. A very big sky.')
    expect(prompt).not.toContain('folder: ~/alpha')
    expect(saved.page).toBe('pages/Alpha.md')
    // A page without a folder starts in its drawer's folder; the drawer's own chat too.
    const loose = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 3 } })
    expect(loose.body).toMatchObject({ cwd: '~/scratch', page: 'pages/Loose.md' })
    const own = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), drawer: 0 })
    expect(own.body).toMatchObject({ host: 'drawer:Work', slot: null, cwd: '~/scratch', agent: 'claude' })
    expect(own.body.page).toBeUndefined()
    expect((await call('POST', '/api/chats', { profile: 'work', rev: rev(), drawer: 4 })).status).toBe(404)
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
    const step = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 1 })
    const renamed = await call('POST', '/api/profiles/work/ops', {
      rev: rev(),
      ops: [{ op: 'updateStep', at: { section: 0, index: 0 }, index: 1, step: { label: 'claude', type: 'chat', args: ['--model', 'opus'] } }],
    })
    expect(renamed.status).toBe(200)
    expect(server.chats.get(step.body.id)?.slot).toBe('step:~/alpha|claude')
    const again = await call<Chat>('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 }, step: 1 })
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
    await until(() => server.chats.text(chat.id).split('\n').every((l) => l.length <= 90 || l.startsWith('args=') || l.startsWith('FAKE CLAUDE cwd=')), 'the size')
    ws.close()
  })

  test('the guard wants an Origin on the socket', () => {
    const check = makeGuard([7420])
    expect(check({ host: '127.0.0.1:7420' }, '/pty/x')).toMatch(/Origin/)
    expect(check({ host: '127.0.0.1:7420', origin: 'http://127.0.0.1:7420' }, '/pty/x')).toBeNull()
  })
})
