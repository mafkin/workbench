import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SetupDoc } from '../shared/claude-setup.ts'
import { readSetup } from '../server/claude-setup.ts'

let dir: string
let home: string
let alpha: string
let managed: string

const SECRETS = ['OAUTH-SECRET-1', 'USER-SECRET-2', 'USER-SECRET-3', 'USER-SECRET-4', 'LOCAL-SECRET-5', 'HISTORY-SECRET-6', 'HOOK-SECRET-7', 'SETTINGS-SECRET-8', 'PLUGIN-SECRET-9']

async function write(file: string, content: string | object) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}

const md = (front: Record<string, unknown> | null, body: string) =>
  `${front ? `---\n${Object.entries(front).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n` : ''}${body}\n`

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-setup-')))
  home = path.join(dir, 'home')
  alpha = path.join(home, 'alpha')
  managed = path.join(dir, 'managed')
  const claude = path.join(home, '.claude')
  const data = path.join(claude, 'plugins/cache/acme/data/1.0.0')
  const tools = path.join(claude, 'plugins/cache/acme/tools/0.1.0')

  await write(path.join(home, '.claude.json'), {
    oauthAccount: { emailAddress: 'me@example.com', accessToken: 'OAUTH-SECRET-1' },
    mcpServers: {
      notes: { command: 'npx', args: ['-y', 'notes-mcp', '--api-key', 'USER-SECRET-2'], env: { NOTES_TOKEN: 'USER-SECRET-3', MODE: 'fast', REF: '${HOME_TOKEN}' } },
      shared: { type: 'http', url: 'https://user.example/mcp', headers: { Authorization: 'Bearer USER-SECRET-4' } },
      odd: { type: 'http' },
    },
    projects: {
      [alpha]: {
        mcpServers: { shared: { type: 'sse', url: 'https://local.example/sse?key=LOCAL-SECRET-5' } },
        disabledMcpServers: ['offline'],
        history: [{ display: 'HISTORY-SECRET-6' }],
      },
    },
  })
  await write(path.join(claude, 'settings.json'), {
    enabledPlugins: { 'data@acme': true, 'tools@acme': false },
    env: { ANTHROPIC_API_KEY: 'SETTINGS-SECRET-8' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/guard.sh --token HOOK-SECRET-7', timeout: 30 }] }] },
  })
  await write(path.join(claude, 'skills/review/SKILL.md'), md({ name: 'review', description: 'Reviews code', 'allowed-tools': ['Read', 'Grep'] }, '# Review\n\nLook closely.'))
  await write(path.join(claude, 'skills/deploy/SKILL.md'), md(null, '\nShips the current branch.\n\nMore here.'))
  await write(path.join(claude, 'skills/broken/SKILL.md'), '---\nname: [unclosed\n---\nBody\n')
  await write(path.join(claude, 'skills/synced/bucket-1/memory/SKILL.md'), md({ name: 'memory', description: 'Remembers things' }, 'Body'))
  await write(path.join(claude, 'commands/frontend/component.md'), md({ description: 'Makes a component', 'argument-hint': '<name>' }, 'Make $ARGUMENTS'))
  await write(path.join(claude, 'commands/deploy.md'), md({ description: 'Old deploy command' }, 'Deploy'))
  await write(path.join(claude, 'agents/critic.md'), md({ name: 'critic', description: 'Your critic', model: 'opus' }, 'Be harsh.'))
  await write(path.join(claude, 'agents/nameless.md'), md({ name: 'nameless' }, 'No description'))

  await write(path.join(claude, 'plugins/installed_plugins.json'), {
    version: 2,
    plugins: {
      'data@acme': [{ scope: 'user', installPath: data, version: '1.0.0' }],
      'tools@acme': [{ scope: 'user', installPath: tools, version: '0.1.0' }],
    },
  })
  await write(path.join(claude, 'plugins/known_marketplaces.json'), { acme: { source: { source: 'github', repo: 'acme/claude-plugins' }, installLocation: '/x', lastUpdated: 'now' } })
  await write(path.join(data, '.claude-plugin/plugin.json'), { name: 'data', version: '1.0.0', description: 'Data tools', author: { name: 'Acme' }, agents: './custom-agents' })
  await write(path.join(data, 'skills/analyze/SKILL.md'), md({ name: 'analyze', description: 'Answers data questions' }, 'Analyze'))
  await write(path.join(data, 'commands/report.md'), md({ description: 'Writes a report' }, 'Report'))
  await write(path.join(data, 'agents/ignored.md'), md({ name: 'ignored', description: 'Not loaded: the manifest names other agents' }, 'x'))
  await write(path.join(data, 'custom-agents/review/security.md'), md({ name: 'security', description: 'Security review' }, 'x'))
  await write(path.join(data, 'hooks/hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/start.sh' }] }] } })
  await write(path.join(data, '.mcp.json'), { mcpServers: { warehouse: { type: 'http', url: 'https://wh.example/mcp', headers: { 'X-Api-Key': 'PLUGIN-SECRET-9' } } } })
  await write(path.join(tools, '.claude-plugin/plugin.json'), { name: 'tools', description: 'Off for now' })
  await write(path.join(tools, 'skills/lint/SKILL.md'), md({ name: 'lint', description: 'Lints' }, 'x'))

  await fsp.mkdir(path.join(alpha, '.git'), { recursive: true })
  await write(path.join(alpha, '.mcp.json'), {
    mcpServers: {
      shared: { command: 'node', args: ['x.js'] },
      approved: { command: 'node', args: ['a.js'] },
      waiting: { command: 'node', args: ['srv.js'] },
      offline: { command: 'node' },
      rejected: { command: 'node' },
    },
  })
  await write(path.join(alpha, '.claude/settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the tests ran' }] }] } })
  await write(path.join(alpha, '.claude/settings.local.json'), { enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['rejected'] })
  await write(path.join(alpha, '.claude/skills/review/SKILL.md'), md({ name: 'review', description: 'Project review' }, 'x'))
  await write(path.join(alpha, '.claude/skills/alpha-only/SKILL.md'), md({ description: 'Only in alpha' }, 'x'))
  await write(path.join(alpha, '.claude/agents/critic.md'), md({ name: 'critic', description: 'Project critic' }, 'x'))
  await write(path.join(alpha, '.claude/commands/build.md'), md({ description: 'Builds' }, 'x'))
  await write(path.join(alpha, 'sub/.claude/skills/inner/SKILL.md'), md({ description: 'Inner skill' }, 'x'))
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const read = (folder: string | null = alpha) => readSetup({ home, managedDir: managed, folder })
const names = (docs: SetupDoc[]) => docs.map((d) => `${d.scope}:${d.name}${d.overriddenBy ? ' (overridden)' : ''}`).sort()

describe('reading the Claude setup for a folder', () => {
  it('lists skills from you, the project up to its git root, and enabled plugins', async () => {
    const { setup } = await read(path.join(alpha, 'sub'))
    expect(names(setup.skills)).toEqual([
      'plugin:data:analyze',
      'project:alpha-only',
      'project:inner',
      'project:review (overridden)',
      'user:broken',
      'user:deploy',
      'user:memory',
      'user:review',
    ])
    const review = setup.skills.find((s) => s.scope === 'project' && s.name === 'review')!
    expect(review.overriddenBy).toBe('your skill review')
    expect(review.path).toBe('~/alpha/.claude/skills/review/SKILL.md')
    expect(setup.skills.find((s) => s.name === 'review' && s.scope === 'user')!.fields).toEqual([['allowed-tools', 'Read, Grep']])
    expect(setup.skills.find((s) => s.name === 'deploy')!.description).toBe('Ships the current branch.')
    expect(setup.skills.find((s) => s.name === 'memory')!.synced).toBe(true)
    expect(setup.skills.find((s) => s.name === 'data:analyze')!.plugin).toBe('data')
    expect(setup.problems.map((p) => p.path)).toContain('~/.claude/skills/broken/SKILL.md')
  })

  it('lists commands with namespaces, and a skill of the same name wins', async () => {
    const { setup } = await read()
    expect(names(setup.commands)).toEqual(['plugin:data:report', 'project:build', 'user:deploy (overridden)', 'user:frontend:component'])
    expect(setup.commands.find((c) => c.name === 'deploy')!.overriddenBy).toBe('skill deploy')
  })

  it('lists agents: the project’s wins, plugin agents follow the manifest, and incomplete ones are skipped', async () => {
    const { setup } = await read()
    expect(names(setup.agents)).toEqual(['plugin:data:review:security', 'project:critic', 'user:critic (overridden)'])
    expect(setup.problems.find((p) => p.path === '~/.claude/agents/nameless.md')?.message).toMatch(/description/)
  })

  it('gives each MCP server its scope and state', async () => {
    const { setup } = await read()
    const state = Object.fromEntries(setup.mcp.map((m) => [`${m.scope}:${m.name}`, m.state]))
    expect(state).toEqual({
      'user:notes': 'on',
      'user:shared': 'overridden',
      'user:odd': 'broken',
      'local:shared': 'on',
      'project:shared': 'overridden',
      'project:approved': 'on',
      'project:waiting': 'pending',
      'project:offline': 'off',
      'project:rejected': 'off',
      'plugin:warehouse': 'on',
    })
    const waiting = setup.mcp.find((m) => m.name === 'waiting')!
    expect(waiting).toMatchObject({ transport: 'stdio', command: 'node', args: ['srv.js'], confirm: true })
    expect(waiting.uncheckable).toBeUndefined()
    expect(setup.mcp.find((m) => m.name === 'offline')!.uncheckable).toMatch(/off/)
    const local = setup.mcp.find((m) => m.scope === 'local')!
    expect(local.transport).toBe('sse')
    expect(local.path).toBe('~/.claude.json')
    expect(setup.mcp.find((m) => m.scope === 'user' && m.name === 'shared')!.note).toMatch(/local/)
  })

  it('masks every secret, and reads nothing else from ~/.claude.json', async () => {
    const { setup } = await read()
    const json = JSON.stringify(setup)
    for (const s of SECRETS) expect(json).not.toContain(s)
    expect(json).not.toContain('me@example.com')
    const notes = setup.mcp.find((m) => m.name === 'notes')!
    expect(notes.args).toEqual(['-y', 'notes-mcp', '--api-key', '••••••'])
    expect(notes.env).toEqual([
      ['NOTES_TOKEN', '••••••'],
      ['MODE', '••••••'],
      ['REF', '${HOME_TOKEN}'],
    ])
    expect(setup.mcp.find((m) => m.scope === 'user' && m.name === 'shared')!.headers).toEqual([['Authorization', 'Bearer ••••••']])
  })

  it('lists hooks from each settings file and enabled plugins', async () => {
    const { setup } = await read()
    expect(setup.hooks.map((h) => `${h.scope}:${h.event}:${h.matcher}:${h.type}`).sort()).toEqual(['plugin:SessionStart::command', 'project:Stop::prompt', 'user:PreToolUse:Bash:command'])
    expect(setup.hooks.find((h) => h.event === 'PreToolUse')).toMatchObject({ run: '~/bin/guard.sh --token ••••••', timeout: 30, path: '~/.claude/settings.json' })
  })

  it('lists plugins, on or off, with what they provide', async () => {
    const { setup } = await read()
    expect(setup.plugins).toEqual([
      expect.objectContaining({
        id: 'data@acme',
        name: 'data',
        marketplace: 'acme',
        version: '1.0.0',
        description: 'Data tools',
        author: 'Acme',
        source: 'github.com/acme/claude-plugins',
        enabled: true,
        setIn: '~/.claude/settings.json',
        path: '~/.claude/plugins/cache/acme/data/1.0.0',
        provides: { skills: 1, commands: 1, agents: 1, hooks: 1, mcp: 1 },
      }),
      expect.objectContaining({ id: 'tools@acme', enabled: false, provides: { skills: 1, commands: 0, agents: 0, hooks: 0, mcp: 0 } }),
    ])
  })

  it('everywhere: no project or local items', async () => {
    const { setup } = await read(null)
    expect(setup.folder).toBeNull()
    expect(setup.mcp.map((m) => `${m.scope}:${m.name}:${m.state}`)).toEqual(['user:notes:on', 'user:shared:on', 'user:odd:broken', 'plugin:warehouse:on'])
    expect(setup.skills.some((s) => s.scope === 'project')).toBe(false)
    expect(setup.hooks.map((h) => h.scope).sort()).toEqual(['plugin', 'user'])
  })

  it('a project setting can turn a plugin off for that folder', async () => {
    await write(path.join(alpha, '.claude/settings.local.json'), { enabledPlugins: { 'data@acme': false } })
    const { setup } = await read()
    expect(setup.plugins.find((p) => p.id === 'data@acme')).toMatchObject({ enabled: false, setIn: '~/alpha/.claude/settings.local.json' })
    expect(setup.skills.some((s) => s.plugin === 'data')).toBe(false)
    expect(setup.mcp.some((m) => m.plugin === 'data')).toBe(false)
  })

  it('managed-mcp.json decides alone; managed settings can deny or allow servers', async () => {
    await write(path.join(managed, 'managed-settings.json'), { deniedMcpServers: [{ serverName: 'notes' }] })
    let { setup } = await read(null)
    expect(setup.mcp.find((m) => m.name === 'notes')).toMatchObject({ state: 'blocked', uncheckable: expect.stringMatching(/blocked/) })
    expect(setup.mcp.find((m) => m.name === 'shared')!.state).toBe('on')

    await write(path.join(managed, 'managed-settings.json'), { allowedMcpServers: [{ serverUrl: 'https://user.example/*' }] })
    ;({ setup } = await read(null))
    expect(setup.mcp.find((m) => m.name === 'notes')!.state).toBe('blocked')
    expect(setup.mcp.find((m) => m.name === 'shared')!.state).toBe('on')

    await write(path.join(managed, 'managed-mcp.json'), { mcpServers: { corp: { type: 'http', url: 'https://corp.example/mcp' } } })
    await write(path.join(managed, '.claude/skills/policy/SKILL.md'), md({ description: 'Company policy' }, 'x'))
    ;({ setup } = await read())
    expect(setup.mcp.find((m) => m.name === 'corp')).toMatchObject({ scope: 'managed', state: 'on', path: path.join(managed, 'managed-mcp.json') })
    expect(setup.mcp.filter((m) => m.scope !== 'managed').every((m) => m.state === 'blocked' || m.state === 'broken')).toBe(true)
    expect(setup.skills.find((s) => s.name === 'policy')!.scope).toBe('managed')
  })

  it('a broken file is a problem, not a failure', async () => {
    await write(path.join(alpha, '.mcp.json'), '{ "mcpServers": { oops')
    await write(path.join(home, '.claude/plugins/installed_plugins.json'), '[1, 2]')
    const { setup } = await read()
    expect(setup.problems.map((p) => p.path)).toEqual(expect.arrayContaining(['~/alpha/.mcp.json', '~/.claude/plugins/installed_plugins.json']))
    expect(setup.mcp.some((m) => m.scope === 'user')).toBe(true)
    // Enabled but not installed: listed as missing.
    expect(setup.plugins.find((p) => p.id === 'data@acme')).toMatchObject({ enabled: true, missing: true })
  })

  it('a project at home does not count your settings twice', async () => {
    const { setup } = await read(home)
    expect(setup.hooks.map((h) => `${h.scope}:${h.event}`).sort()).toEqual(['plugin:SessionStart', 'user:PreToolUse'])
    expect(setup.skills.filter((s) => s.name === 'review').map((s) => s.scope)).toEqual(['user'])
  })

  it('keeps the raw config of each server and the file of each document for the service', async () => {
    const { setup, servers, files } = await read()
    const notes = setup.mcp.find((m) => m.name === 'notes')!
    expect(servers.get(notes.id)!.config).toMatchObject({ env: { NOTES_TOKEN: 'USER-SECRET-3' } })
    const warehouse = setup.mcp.find((m) => m.name === 'warehouse')!
    expect(servers.get(warehouse.id)!.pluginRoot).toBe(path.join(home, '.claude/plugins/cache/acme/data/1.0.0'))
    const analyze = setup.skills.find((s) => s.name === 'data:analyze')!
    expect(files.get(analyze.id)).toBe(path.join(home, '.claude/plugins/cache/acme/data/1.0.0/skills/analyze/SKILL.md'))
  })
})
