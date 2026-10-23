import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeSetup, McpCheck } from '../shared/claude-setup.ts'
import { buildServer } from '../server/main.ts'

const FAKE_MCP = path.resolve('tests/fixtures/fake-mcp.mjs')
const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

const WORK = `name: Work
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha }
      - { label: Loose, type: item, id: abc12345, steps: [] }
`

let dir: string
let home: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

async function call<T = any>(method: 'GET' | 'POST', url: string, payload?: object, h: Record<string, string> = headers): Promise<{ status: number; body: T }> {
  const res = await server.app.inject({ method, url, headers: h, payload })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

async function write(file: string, content: object | string) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-setup-http-')))
  home = path.join(dir, 'home')
  const alpha = path.join(home, 'alpha')
  await write(path.join(home, '.claude.json'), {
    mcpServers: { tools: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_TOKEN: 'tok-SECRET-1' } } },
  })
  await write(path.join(home, '.claude/skills/review/SKILL.md'), '---\nname: review\ndescription: Reviews\n---\n# Review\n\nLook at FOO_TOKEN=abc123 closely.\n')
  await write(path.join(alpha, '.mcp.json'), { mcpServers: { local: { command: process.execPath, args: [FAKE_MCP] } } })
  await write(path.join(home, 'elsewhere/.mcp.json'), { mcpServers: {} })
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  // Home is outside the profile's folders here: only Alpha may be read.
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), `${WORK}home: ~/alpha\n`)
  server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), managedDir: path.join(dir, 'managed'), mcpTimeoutMs: 5000, chatCommands: { claude: FAKE_CLAUDE, shell: FAKE_SHELL } })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('the Claude setup routes', () => {
  it('lists the setup for everywhere or for a folder of the profile, masked', async () => {
    const all = await call<ClaudeSetup>('GET', '/api/claude/setup?profile=work')
    expect(all.status).toBe(200)
    expect(all.body.mcp.map((m) => m.name)).toEqual(['tools'])
    expect(JSON.stringify(all.body)).not.toContain('tok-SECRET-1')
    const alpha = await call<ClaudeSetup>('GET', `/api/claude/setup?profile=work&path=${encodeURIComponent('~/alpha')}`)
    expect(alpha.body.folder).toBe('~/alpha')
    expect(alpha.body.mcp.map((m) => `${m.scope}:${m.name}:${m.state}`)).toEqual(['user:tools:on', 'project:local:pending'])
  })

  it('refuses folders outside the profile and calls without the header', async () => {
    expect((await call('GET', `/api/claude/setup?profile=work&path=${encodeURIComponent('~/elsewhere')}`)).status).toBe(403)
    expect((await call('GET', '/api/claude/setup?profile=work', undefined, { host: '127.0.0.1:7420' })).status).toBe(403)
    expect((await call('POST', '/api/claude/check', { profile: 'work', id: 'x' }, { host: '127.0.0.1:7420' })).status).toBe(403)
  })

  it('gives the body of a listed document, masked, by id only', async () => {
    const { body: setup } = await call<ClaudeSetup>('GET', '/api/claude/setup?profile=work')
    const doc = await call('GET', `/api/claude/doc?profile=work&id=${encodeURIComponent(setup.skills[0].id)}`)
    expect(doc.status).toBe(200)
    expect(doc.body.body).toContain('# Review')
    expect(doc.body.body).not.toContain('abc123')
    expect((await call('GET', `/api/claude/doc?profile=work&id=${encodeURIComponent(`skill:${path.join(home, '.claude.json')}`)}`)).status).toBe(404)
  })

  it('checks a server by id, from the config, never from the request', async () => {
    const { body: setup } = await call<ClaudeSetup>('GET', '/api/claude/setup?profile=work')
    const res = await call<McpCheck>('POST', '/api/claude/check', { profile: 'work', id: setup.mcp[0].id, command: 'rm', args: ['-rf', '/'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, server: 'fake-mcp 1.2.3' })
    expect((await call('POST', '/api/claude/check', { profile: 'work', id: 'mcp:user::nope' })).status).toBe(404)
  })

  it('a project server not approved yet is checked only when confirmed', async () => {
    const { body: setup } = await call<ClaudeSetup>('GET', `/api/claude/setup?profile=work&path=${encodeURIComponent('~/alpha')}`)
    const local = setup.mcp.find((m) => m.scope === 'project')!
    expect(local.confirm).toBe(true)
    const refused = await call('POST', '/api/claude/check', { profile: 'work', path: '~/alpha', id: local.id })
    expect(refused).toMatchObject({ status: 409, body: { confirm: true } })
    const ok = await call<McpCheck>('POST', '/api/claude/check', { profile: 'work', path: '~/alpha', id: local.id, confirm: true })
    expect(ok.body.ok).toBe(true)
    // It ran in the project folder.
    expect(ok.body.tools.find((t) => t.name === 'cwd')!.description).toBe(`Runs in ${path.join(home, 'alpha')}`)
  })

  it('refuses to check a server that is off', async () => {
    await write(path.join(home, 'alpha/.claude/settings.local.json'), { disabledMcpjsonServers: ['local'] })
    const { body: setup } = await call<ClaudeSetup>('GET', `/api/claude/setup?profile=work&path=${encodeURIComponent('~/alpha')}`)
    const local = setup.mcp.find((m) => m.scope === 'project')!
    expect((await call('POST', '/api/claude/check', { profile: 'work', path: '~/alpha', id: local.id, confirm: true })).status).toBe(422)
  })
})

describe('switching MCP servers', () => {
  const alphaQ = { profile: 'work', path: '~/alpha' }
  const claudeJsonOf = async () => JSON.parse(await fsp.readFile(path.join(home, '.claude.json'), 'utf8'))
  const rev = () => server.store.profile('work').rev
  const states = (s: ClaudeSetup) => Object.fromEntries(s.mcp.map((m) => [m.key, m.state]))

  it('in a folder: writes the folder’s disabledMcpServers, like /mcp, and returns the new setup', async () => {
    const off = await call<{ setup: ClaudeSetup }>('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: false })
    expect(off.status).toBe(200)
    expect(states(off.body.setup)).toMatchObject({ tools: 'off' })
    const json = await claudeJsonOf()
    expect(json.projects[path.join(home, 'alpha')].disabledMcpServers).toEqual(['tools'])
    expect(json.mcpServers.tools.env.FAKE_MCP_TOKEN).toBe('tok-SECRET-1')
    const on = await call<{ setup: ClaudeSetup }>('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: true })
    expect(states(on.body.setup)).toMatchObject({ tools: 'on' })
    // Not in the profile's defaults: the YAML is untouched.
    expect(server.store.profile('work').profile!.mcpOff).toBeUndefined()
  })

  it('takes only servers the setup lists, in folders of the profile', async () => {
    expect((await call('POST', '/api/claude/mcp', { ...alphaQ, keys: ['nope'], on: false })).status).toBe(422)
    expect((await call('POST', '/api/claude/mcp', { profile: 'work', path: '~/elsewhere', keys: ['tools'], on: false })).status).toBe(403)
    expect((await call('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: false }, { host: '127.0.0.1:7420' })).status).toBe(403)
  })

  it('refuses a server that cannot be switched', async () => {
    await write(path.join(home, '.claude.json'), { mcpServers: { tools: { command: process.execPath, args: [FAKE_MCP] }, odd: { type: 'http' } } })
    const res = await call('POST', '/api/claude/mcp', { ...alphaQ, keys: ['odd'], on: false })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/usable/)
  })

  it('everywhere: the profile’s default, written to the YAML and to every project now', async () => {
    expect((await call('POST', '/api/claude/mcp', { profile: 'work', keys: ['tools'], on: false })).status).toBe(422)
    const off = await call<{ setup: ClaudeSetup; rev: string }>('POST', '/api/claude/mcp', { profile: 'work', keys: ['tools'], on: false, rev: rev() })
    expect(off.status).toBe(200)
    expect(off.body.rev).toBe(rev())
    expect(server.store.profile('work').profile!.mcpOff).toEqual(['tools'])
    expect(states(off.body.setup)).toMatchObject({ tools: 'off' })
    expect((await claudeJsonOf()).projects[path.join(home, 'alpha')].disabledMcpServers).toEqual(['tools'])
    // Switched back on in Alpha: on there, with a note.
    const alpha = await call<{ setup: ClaudeSetup }>('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: true })
    expect(alpha.body.setup.mcp.find((m) => m.key === 'tools')).toMatchObject({ state: 'on', note: expect.stringMatching(/off by default/) })
    // On everywhere: out of the YAML and on in every project.
    await call('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: false })
    await call('POST', '/api/claude/mcp', { profile: 'work', keys: ['tools'], on: true, rev: rev() })
    expect(server.store.profile('work').profile!.mcpOff).toBeUndefined()
    expect((await claudeJsonOf()).projects[path.join(home, 'alpha')].disabledMcpServers).toEqual([])
  })

  it('a chat turns the defaults off in its folder the first time, and not again', { timeout: 15_000 }, async () => {
    // A default added by hand: no project has had it yet.
    await server.store.apply('work', rev(), [{ op: 'setMcpOff', names: ['tools'], off: true }])
    const first = await call('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    expect(first.status).toBe(200)
    expect((await claudeJsonOf()).projects[path.join(home, 'alpha')].disabledMcpServers).toEqual(['tools'])
    await call('POST', '/api/claude/mcp', { ...alphaQ, keys: ['tools'], on: true })
    await call('POST', '/api/chats', { profile: 'work', rev: rev(), at: { section: 0, index: 0 } })
    expect((await claudeJsonOf()).projects[path.join(home, 'alpha')].disabledMcpServers).toEqual([])
  })
})
