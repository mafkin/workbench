import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Chat } from '../shared/config-schema.ts'
import { buildServer } from '../server/main.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

const WORK = `name: Work
workflow:
  - { label: review, type: chat, agent: Reviewer }
agents:
  Reviewer:
    model: opus
    permission: plan
    prompt: Look at the diff
  Wild:
    agent: orchestrator
    model: opus
    permission: bypassPermissions
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha, agent: Reviewer }
      - { label: Beta, type: folder, path: ~/beta }
      - { label: Scratch, type: chat, path: ~/beta, agent: wild }
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>

const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }
const rev = () => server.store.profile('work').rev
const ALPHA = { section: 0, index: 0 }
const BETA = { section: 0, index: 1 }

async function call<T = any>(method: 'GET' | 'POST', url: string, payload?: object): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers, payload })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined }
}

const start = <T = Chat>(req: object) => call<T>('POST', '/api/chats', { profile: 'work', rev: rev(), ...req })

async function sees(id: string, text: string, timeout = 5000) {
  const end = Date.now() + timeout
  while (!server.chats.text(id).includes(text)) {
    if (Date.now() > end) throw new Error(`Timed out waiting for "${text}" in:\n${server.chats.text(id)}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-agents-http-')))
  home = path.join(dir, 'home')
  for (const d of ['alpha', 'beta', 'elsewhere', '.claude/agents']) await fsp.mkdir(path.join(home, d), { recursive: true })
  await fsp.writeFile(path.join(home, '.claude/agents/orch.md'), '---\nname: orchestrator\n---\nYou coordinate.\n')
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

describe('agent profiles at chat start', { timeout: 15_000 }, () => {
  test("New chat starts the project's default agent profile, with its flags and first prompt", async () => {
    const { body: chat } = await start({ at: ALPHA })
    expect(chat).toMatchObject({ agentProfile: 'Reviewer', bypass: false, agent: 'claude' })
    await sees(chat.id, `args=["--model","opus","--permission-mode","plan","--session-id","${chat.session}","--settings"`)
    await sees(chat.id, 'prompt=Look at the diff')
  })

  test('the menu can pick plain claude, the shell, or another profile by name in any case', async () => {
    expect((await start({ at: ALPHA, agent: 'claude' })).body).toMatchObject({ agentProfile: null, agent: 'claude' })
    expect((await start({ at: ALPHA, agent: 'shell' })).body).toMatchObject({ agentProfile: null, agent: 'shell' })
    const { body: wild } = await start({ at: BETA, agent: 'wild' })
    expect(wild).toMatchObject({ agentProfile: 'Wild', bypass: true })
    // The Claude agent decides the model: --model is left out.
    await sees(wild.id, `args=["--agent","orchestrator","--permission-mode","bypassPermissions","--session-id"`)
    expect((await start({ at: BETA })).body).toMatchObject({ agentProfile: null })
  })

  test('chat steps and chat entries name their profile; an unknown name is refused', async () => {
    expect((await start({ at: BETA, step: 1 })).body).toMatchObject({ agentProfile: 'Reviewer', slot: 'step:~/beta|review' })
    expect((await start({ at: { section: 0, index: 2 } })).body).toMatchObject({ agentProfile: 'Wild' })
    const unknown = await start<{ error: string }>({ at: ALPHA, agent: 'Nobody' })
    expect(unknown.status).toBe(422)
    expect(unknown.body.error).toMatch(/No agent profile named Nobody/)
  })

  test('a new session sends the first prompt again; resume and summarize-and-continue do not', async () => {
    const { body: chat } = await start({ at: ALPHA })
    await sees(chat.id, 'prompt=Look at the diff')
    const next = await call<Chat>('POST', `/api/chats/${chat.id}/handoff`)
    expect(next.body).toMatchObject({ agentProfile: 'Reviewer' })
    await sees(next.body.id, '"--model","opus"')
    await sees(next.body.id, 'prompt=Continue from this handoff')
    expect(server.chats.text(next.body.id)).not.toContain('Look at the diff')

    server.chats.write(chat.id, 'exit\r')
    const end = Date.now() + 5000
    while (server.chats.get(chat.id)?.state !== 'exited' && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    await call('POST', `/api/chats/${chat.id}/start`, { fresh: false })
    await sees(chat.id, 'resumed=true')
    expect(server.chats.text(chat.id)).not.toContain('prompt=')
    server.chats.write(chat.id, 'exit\r')
    while (server.chats.get(chat.id)?.state !== 'exited' && Date.now() < end + 5000) await new Promise((r) => setTimeout(r, 25))
    await call('POST', `/api/chats/${chat.id}/start`, { fresh: true })
    await sees(chat.id, 'prompt=Look at the diff')
  })

  test("lists Claude Code agents for the editor, only in the profile's folders", async () => {
    const res = await call<string[]>('GET', `/api/chats/claude-agents?profile=work&path=${encodeURIComponent('~/alpha')}`)
    expect(res.body).toEqual(['orchestrator'])
    expect((await call('GET', `/api/chats/claude-agents?profile=work&path=${encodeURIComponent('~/elsewhere')}`)).status).toBe(403)
  })
})
