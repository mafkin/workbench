import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Chats, type ChatSpec } from '../server/chats.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

let dir: string
let home: string
let project: string
let chats: Chats

const make = () => new Chats({ stateDir: path.join(dir, 'state'), home, commands: { claude: FAKE_CLAUDE, shell: FAKE_SHELL }, quietMs: 150, busyMs: 300 })

const spec = (over: Partial<ChatSpec> = {}): ChatSpec => ({ profile: 'work', host: 'project:~/alpha', slot: null, agent: 'claude', cwd: project, args: [], ...over })

async function until<T>(fn: () => T | Promise<T>, what = 'condition', timeout = 5000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const sees = (id: string, text: string) => until(() => chats.text(id).includes(text), `"${text}" on screen:\n${chats.text(id)}`)

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-chats-')))
  home = path.join(dir, 'home')
  project = path.join(home, 'alpha')
  await fsp.mkdir(project, { recursive: true })
  chats = make()
  await chats.init()
})

afterEach(async () => {
  await chats.shutdown()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('chats', { timeout: 15_000 }, () => {
  test('claude starts in the folder with a session id and the configured args; the screen and title are kept', async () => {
    const chat = await chats.start(spec({ args: ['--model', 'opus'] }))
    expect(chat.state).toBe('running')
    expect(chat.cwd).toBe('~/alpha')
    expect(chat.session).toMatch(/^[0-9a-f-]{36}$/)
    await sees(chat.id, `FAKE CLAUDE cwd=${project}`)
    await sees(chat.id, `session=${chat.session} resumed=false`)
    await sees(chat.id, `args=["--model","opus","--session-id","${chat.session}"]`)
    await until(() => chats.get(chat.id)?.title === 'Fake Claude', 'the title')

    chats.write(chat.id, 'hello there\r')
    await sees(chat.id, 'you said: hello there')
    expect(chats.screen(chat.id)).toContain('you said: hello there')
  })

  test('the bell asks for attention unless someone is watching with focus', async () => {
    const chat = await chats.start(spec())
    await sees(chat.id, 'args=')
    chats.write(chat.id, 'ring\r')
    await until(() => chats.get(chat.id)?.attention, 'attention')
    chats.seen(chat.id)
    expect(chats.get(chat.id)?.attention).toBe(false)

    const view = chats.attach(chat.id, { send() {}, close() {} })
    view.focus(true)
    chats.write(chat.id, 'ring\r')
    await until(() => chats.text(chat.id).split('you said: ring').length > 2, 'the second ring')
    await new Promise((r) => setTimeout(r, 300))
    expect(chats.get(chat.id)?.attention).toBe(false)
    view.detach()
  })

  test('going quiet after working asks for attention; short output does not', async () => {
    const chat = await chats.start(spec())
    await sees(chat.id, 'args=')
    await new Promise((r) => setTimeout(r, 400))
    expect(chats.get(chat.id)?.attention).toBe(false)
    chats.write(chat.id, 'work\r')
    await sees(chat.id, 'done')
    await until(() => chats.get(chat.id)?.attention, 'attention after work')
  })

  test('a program that exits leaves its last screen; Resume continues the same claude session', async () => {
    const chat = await chats.start(spec())
    chats.write(chat.id, 'remember this\r')
    await sees(chat.id, 'you said: remember this')
    chats.write(chat.id, 'exit\r')
    await until(() => chats.get(chat.id)?.state === 'exited', 'exit')
    expect(chats.get(chat.id)?.exitCode).toBe(0)
    expect(chats.text(chat.id)).toContain('you said: remember this')

    await chats.restart(chat.id, { fresh: false })
    await sees(chat.id, `session=${chat.session} resumed=true`)
    expect(chats.get(chat.id)?.messages).toBe(1)
  })

  test('after a restart of the service chats are stopped, and nothing starts by itself', async () => {
    const a = await chats.start(spec())
    await chats.update(a.id, { label: 'parser', color: '#8fa58a', pinned: true })
    chats.write(a.id, 'first\r')
    await sees(a.id, 'you said: first')
    const shell = await chats.start(spec({ agent: 'shell' }))
    await chats.shutdown()
    expect(fs.statSync(path.join(dir, 'state/chats.json')).mode & 0o777).toBe(0o600)

    chats = make()
    await chats.init()
    const list = chats.list('work')
    expect(list.map((c) => [c.id, c.state, c.label, c.pinned])).toEqual([
      [a.id, 'stopped', 'parser', true],
      [shell.id, 'stopped', null, false],
    ])
    expect(chats.text(a.id)).toBe('')

    await chats.restart(a.id, { fresh: false })
    await sees(a.id, `session=${a.session} resumed=true`)
    await chats.restart(shell.id, { fresh: false })
    await sees(shell.id, 'FAKE SHELL')
  })

  test('a session with nothing said yet starts again with the same id, and New session gets a new one', async () => {
    const chat = await chats.start(spec())
    await sees(chat.id, 'args=')
    chats.write(chat.id, 'exit\r')
    await until(() => chats.get(chat.id)?.state === 'exited', 'exit')
    await chats.restart(chat.id, { fresh: false })
    await sees(chat.id, `session=${chat.session} resumed=false`)
    chats.write(chat.id, 'exit\r')
    await until(() => chats.get(chat.id)?.state === 'exited', 'exit')
    const fresh = await chats.restart(chat.id, { fresh: true })
    expect(fresh.session).not.toBe(chat.session)
    await sees(chat.id, `session=${fresh.session} resumed=false`)
  })

  test('the shell is a login shell in the folder, with no session', async () => {
    const chat = await chats.start(spec({ agent: 'shell' }))
    expect(chat.session).toBeNull()
    await sees(chat.id, `FAKE SHELL cwd=${project} args=["-l"]`)
    chats.write(chat.id, 'make all\r')
    await sees(chat.id, 'ran: make all')
  })

  test('Resume of an earlier session from History', async () => {
    const id = '00000000-0000-4000-8000-000000000042'
    const chat = await chats.start(spec({ resume: id }))
    expect(chat.session).toBe(id)
    await sees(chat.id, `session=${id} resumed=true`)
  })

  test('summarize and continue: a new chat seeded with the summary; a slot moves to it', async () => {
    const chat = await chats.start(spec())
    chats.write(chat.id, 'fix the parser\r')
    await sees(chat.id, 'you said: fix the parser')
    const next = await chats.handoff(chat.id)
    expect(next.session).not.toBe(chat.session)
    await sees(next.id, `prompt=Continue from this handoff of an earlier session (${chat.session}): |  | SUMMARY of ${chat.session}`)
    expect(chats.get(chat.id)?.state).toBe('running')

    const slotted = await chats.start(spec({ slot: 'step:~/alpha|agent' }))
    await sees(slotted.id, 'args=')
    chats.write(slotted.id, 'hi\r')
    await sees(slotted.id, 'you said: hi')
    const moved = await chats.handoff(slotted.id)
    expect(moved.slot).toBe('step:~/alpha|agent')
    expect(chats.get(slotted.id)).toBeUndefined()
  })

  test('attach replays the screen, then streams output; close ends the program', async () => {
    const chat = await chats.start(spec())
    await sees(chat.id, 'args=')
    const frames: string[] = []
    const view = chats.attach(chat.id, { send: (f) => frames.push(f), close() {} })
    await until(() => frames.length, 'the screen')
    expect(frames[0].startsWith('r')).toBe(true)
    expect(frames[0]).toContain('FAKE CLAUDE')
    chats.write(chat.id, 'streamed\r')
    await until(() => frames.some((f) => f.startsWith('o') && f.includes('streamed')), 'streamed output')
    view.detach()

    const pid = chats.pid(chat.id)!
    await chats.close(chat.id)
    expect(chats.get(chat.id)).toBeUndefined()
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }, 'the program to end')
  })

  test('saves of the chat list never overlap, even when they come together', async () => {
    const chat = await chats.start(spec())
    await chats.update(chat.id, { label: 'one' })
    await Promise.all([chats.shutdown(), chats.shutdown(), chats.shutdown()])
    const saved = JSON.parse(await fsp.readFile(path.join(dir, 'state/chats.json'), 'utf8'))
    expect(saved.chats.map((c: { label: string }) => c.label)).toEqual(['one'])
  })

  test('emits a change per profile', async () => {
    const seen: string[] = []
    chats.on('chats', (e: { profile: string }) => seen.push(e.profile))
    await chats.start(spec({ profile: 'personal' }))
    await until(() => seen.includes('personal'), 'a change event')
  })
})
