import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Chat, ContextStatus } from '../shared/config-schema.ts'
import { buildServer } from '../server/main.ts'
import { migrateFixture } from './fixtures/wiki.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

const WORK = `name: Work
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha }
`
const PERSONAL = `name: Personal
sections: []
`

let dir: string
let home: string
let notes: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

async function call<T = any>(method: 'GET' | 'POST', url: string, payload?: object, h: Record<string, string> = headers): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers: h, payload })
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

const exists = (p: string) => fsp.stat(p).then(() => true, () => false)

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-context-')))
  home = path.join(dir, 'home')
  notes = path.join(home, 'wb/work')
  await fsp.mkdir(path.join(home, 'alpha'), { recursive: true })
  await fsp.mkdir(path.join(home, 'elsewhere'), { recursive: true })
  await fsp.writeFile(path.join(home, 'alpha/report.pdf'), 'pdf bytes')
  await fsp.writeFile(path.join(home, 'elsewhere/secret.txt'), 'no')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/settings.yaml'), 'activeProfile: work\nprofiles: [work, personal]\n')
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  await fsp.writeFile(path.join(dir, 'cfg/profiles/personal.yaml'), PERSONAL)
  // Every profile is a folder in the Workbench, its notes and context included: Personal has its own.
  await migrateFixture(path.join(dir, 'cfg'), home)
  server = await buildServer({
    dir: path.join(home, 'wb'),
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

describe('context folders', { timeout: 15_000 }, () => {
  it('is not set up until asked; setup makes the folders and starter notes, never overwriting', async () => {
    let status = (await call<ContextStatus>('GET', '/api/context?profile=work')).body
    expect(status).toMatchObject({ notes: '~/wb/work', ready: false, inbox: 0 })
    expect(status.folders.map((f) => [f.name, f.path, f.exists])).toEqual([
      ['context', '~/wb/work/context', false],
      ['knowledge', '~/wb/work/knowledge', false],
      ['processes', '~/wb/work/processes', false],
      ['inbox', '~/wb/work/inbox', false],
    ])
    expect(await server.context.chatContext('work')).toBeNull()

    await fsp.mkdir(path.join(notes, 'context'), { recursive: true })
    await fsp.writeFile(path.join(notes, 'context/identity.md'), '# Me\n\nI build tools.\n')
    const res = await call<ContextStatus>('POST', '/api/context/setup', { profile: 'work' })
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ ready: true })
    status = res.body
    expect(status.folders.every((f) => f.exists)).toBe(true)
    expect(await fsp.readFile(path.join(notes, 'context/identity.md'), 'utf8')).toBe('# Me\n\nI build tools.\n')
    expect(await fsp.readFile(path.join(notes, 'context/README.md'), 'utf8')).toContain('context/preferences.md')
    expect(await exists(path.join(notes, 'context/preferences.md'))).toBe(true)
    expect(await exists(path.join(notes, 'context/goals.md'))).toBe(true)
    // The folders are entries of the nav: a Context heading at the top, once.
    const index = await fsp.readFile(path.join(notes, 'index.md'), 'utf8')
    expect(index).toContain('## Context\n\n- [Context](context/)\n- [Knowledge](knowledge/)\n- [Processes](processes/)\n- [Inbox](inbox/)\n')
    expect(server.store.profile('work').profile?.sections[0]).toMatchObject({ title: 'Context', items: [{ type: 'folder', label: 'Context', path: '~/wb/work/context' }, {}, {}, { label: 'Inbox', path: '~/wb/work/inbox' }] })
    await call('POST', '/api/context/setup', { profile: 'work' })
    expect((await fsp.readFile(path.join(notes, 'index.md'), 'utf8')).split('## Context').length).toBe(2)
  })

  it('chats are told the routing note and identity, preferences and goals, within a cap', async () => {
    await call('POST', '/api/context/setup', { profile: 'work' })
    await fsp.writeFile(path.join(notes, 'context/README.md'), '# Where things go\n\nReports → preferences.\n')
    await fsp.writeFile(path.join(notes, 'context/preferences.md'), '# Preferences\n\nShort reports, no fluff.\n')
    await fsp.writeFile(path.join(notes, 'context/goals.md'), `# Goals\n\n${'x'.repeat(20_000)}\n`)
    const ctx = (await server.context.chatContext('work'))!
    expect(ctx.dirs).toEqual(['context', 'knowledge', 'processes', 'inbox'].map((f) => path.join(notes, f)))
    expect(ctx.prompt).toContain('profile Work')
    expect(ctx.prompt).toContain(path.join(notes, 'knowledge'))
    expect(ctx.prompt).toContain('Reports → preferences.')
    expect(ctx.prompt).toContain('Short reports, no fluff.')
    expect(ctx.prompt).not.toContain('x'.repeat(20_000))
    expect(ctx.prompt).toContain(`${path.join(notes, 'context/goals.md')} is not included here`)
  })

  it('a new claude chat starts with the context; a shell does not', async () => {
    await call('POST', '/api/context/setup', { profile: 'work' })
    const rev = server.store.profile('work').rev
    // Setup put the Context heading first; Alpha is now in the second heading.
    const chat = (await call<Chat>('POST', '/api/chats', { profile: 'work', rev, at: { section: 1, index: 0 } })).body
    expect(chat.context).toBe(true)
    const saved = await until(async () => {
      const list = JSON.parse(await fsp.readFile(path.join(dir, 'state/chats.json'), 'utf8').catch(() => '{}')).chats ?? []
      return list.find((c: { id: string }) => c.id === chat.id)
    }, 'the saved chat')
    const args: string[] = saved.args
    const prompt = args[args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain('Where things go')
    // The wiki comes with the context, and the project's page is named.
    expect(prompt).toContain(`${notes} holds my notes and the pages`)
    expect(prompt).toContain(`This project's page is ${path.join(notes, 'pages/Alpha.md')}`)
    expect(args.slice(args.indexOf('--add-dir') + 1)).toEqual([...['context', 'knowledge', 'processes', 'inbox'].map((f) => path.join(notes, f)), notes])
    const shell = (await call<Chat>('POST', '/api/chats', { profile: 'work', rev, at: { section: 1, index: 0 }, agent: 'shell' })).body
    expect(shell.context).toBe(false)
  })

  it('Summarize and continue saves the handoff in the inbox', async () => {
    await call('POST', '/api/context/setup', { profile: 'work' })
    const rev = server.store.profile('work').rev
    // Setup put the Context heading first; Alpha is now in the second heading.
    const chat = (await call<Chat>('POST', '/api/chats', { profile: 'work', rev, at: { section: 1, index: 0 } })).body
    await until(() => server.chats.text(chat.id).includes('args='), 'the chat')
    server.chats.write(chat.id, 'fix the parser\r')
    await until(() => server.chats.text(chat.id).includes('you said: fix the parser'), 'an answer')
    expect((await call('POST', `/api/chats/${chat.id}/handoff`, {})).status).toBe(200)
    const [file] = await fsp.readdir(path.join(notes, 'inbox'))
    expect(file).toMatch(/^\d{4}-\d\d-\d\d \d\d\.\d\d Fake Claude\.md$/)
    const text = await fsp.readFile(path.join(notes, 'inbox', file), 'utf8')
    expect(text).toContain(`SUMMARY of ${chat.session}`)
    expect(text).toContain(chat.session!)
    expect((await call<ContextStatus>('GET', '/api/context?profile=work')).body.inbox).toBe(1)
  })

  it('Send to inbox copies a file from the profile’s folders under a free name', async () => {
    await call('POST', '/api/context/setup', { profile: 'work' })
    const first = await call('POST', '/api/context/inbox', { profile: 'work', path: '~/alpha/report.pdf' })
    expect(first).toMatchObject({ status: 200, body: { path: '~/wb/work/inbox/report.pdf' } })
    const second = await call('POST', '/api/context/inbox', { profile: 'work', path: '~/alpha/report.pdf' })
    expect(second.body.path).toBe('~/wb/work/inbox/report 2.pdf')
    expect(await fsp.readFile(path.join(notes, 'inbox/report 2.pdf'), 'utf8')).toBe('pdf bytes')
    expect(await fsp.readFile(path.join(home, 'alpha/report.pdf'), 'utf8')).toBe('pdf bytes')
    // Work's folders are the Workbench folder (its own inside it) and Alpha; nothing else in home.
    expect((await call('POST', '/api/context/inbox', { profile: 'work', path: '~/elsewhere/secret.txt' })).status).toBe(403)
    expect((await call('POST', '/api/context/inbox', { profile: 'work', path: '~/alpha' })).status).toBe(422)
    expect((await call('POST', '/api/context/inbox', { profile: 'work', path: '~/alpha/nope.txt' })).status).toBe(404)
    expect((await call('POST', '/api/context/inbox', { profile: 'work', path: '~/alpha/report.pdf' }, { host: '127.0.0.1:7420' })).status).toBe(403)
  })

  it('tells the app when the inbox changes', async () => {
    await call('POST', '/api/context/setup', { profile: 'work' })
    await call('GET', '/api/context?profile=work')
    // Setup's own event comes 100 ms later; only what follows is the inbox's.
    await new Promise((r) => setTimeout(r, 300))
    const seen: string[] = []
    server.context.on('context', (e: { profile: string }) => seen.push(e.profile))
    await fsp.writeFile(path.join(notes, 'inbox/dropped.txt'), 'hi')
    await until(() => seen.includes('work'), 'a context event')
    expect((await call<ContextStatus>('GET', '/api/context?profile=work')).body.inbox).toBe(1)
  })
})
