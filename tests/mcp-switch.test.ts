import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectKey } from '../server/claude-setup.ts'
import { McpDefaults, setFoldersOff } from '../server/mcp-switch.ts'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-mcp-')))
  file = path.join(dir, '.claude.json')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

const readJson = async () => JSON.parse(await fsp.readFile(file, 'utf8'))

describe('switching MCP servers per folder', () => {
  it('adds and removes names in the folder’s disabledMcpServers, leaving the rest of the file as it was', async () => {
    const before = { numStartups: 3, oauthAccount: { accessToken: 'keep' }, projects: { '/a': { history: [1], disabledMcpServers: ['x'] }, '/b': {} } }
    // Not 0600, which a new file gets: the file's own mode stays.
    await fsp.writeFile(file, JSON.stringify(before, null, 2), { mode: 0o640 })
    await setFoldersOff(file, ['/a'], ['plugin:p:slack', 'x'], true)
    expect((await readJson()).projects['/a'].disabledMcpServers).toEqual(['x', 'plugin:p:slack'])
    await setFoldersOff(file, ['/a'], ['x'], false)
    const after = await readJson()
    expect(after).toEqual({ ...before, projects: { '/a': { history: [1], disabledMcpServers: ['plugin:p:slack'] }, '/b': {} } })
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o640)
    expect(await fsp.readFile(file, 'utf8')).toBe(JSON.stringify(after, null, 2))
  })

  it('makes the folder’s entry, and the file, when they are missing', async () => {
    await setFoldersOff(file, ['/new', '/other'], ['slack'], true)
    expect(await readJson()).toEqual({ projects: { '/new': { disabledMcpServers: ['slack'] }, '/other': { disabledMcpServers: ['slack'] } } })
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('never writes over a file it cannot read', async () => {
    await fsp.writeFile(file, '{ broken')
    await expect(setFoldersOff(file, ['/a'], ['slack'], true)).rejects.toThrow(/not valid JSON/)
    expect(await fsp.readFile(file, 'utf8')).toBe('{ broken')
  })

  it('files a folder inside a repository under the repository’s top folder', async () => {
    await fsp.mkdir(path.join(dir, 'game/.git'), { recursive: true })
    await fsp.mkdir(path.join(dir, 'game/art/blend'), { recursive: true })
    expect(await projectKey(path.join(dir, 'game/art/blend'))).toBe(path.join(dir, 'game'))
    expect(await projectKey(dir)).toBe(dir)
  })
})

describe('the defaults (a drawer’s mcpOff:)', () => {
  it('turns the defaults off once per folder, so one switched back on stays on', async () => {
    const defaults = new McpDefaults({ stateDir: path.join(dir, 'state'), claudeJson: file })
    expect(await defaults.apply(['slack', 'gmail'], '/game')).toEqual(['slack', 'gmail'])
    await setFoldersOff(file, ['/game'], ['slack'], false)
    expect(await defaults.apply(['slack', 'gmail'], '/game')).toEqual([])
    expect((await readJson()).projects['/game'].disabledMcpServers).toEqual(['gmail'])
    // A new default still reaches a folder that has had the others.
    expect(await defaults.apply(['slack', 'gmail', 'notion'], '/game')).toEqual(['notion'])
    // Kept across restarts.
    const again = new McpDefaults({ stateDir: path.join(dir, 'state'), claudeJson: file })
    expect(await again.apply(['slack', 'gmail', 'notion'], '/game')).toEqual([])
    expect((await fsp.stat(path.join(dir, 'state/mcp-defaults.json'))).mode & 0o777).toBe(0o600)
  })

  it('a default taken away and made again applies again', async () => {
    const defaults = new McpDefaults({ stateDir: path.join(dir, 'state'), claudeJson: file })
    await defaults.apply(['slack'], '/game')
    await setFoldersOff(file, ['/game'], ['slack'], false)
    await defaults.forget(['slack'])
    expect(await defaults.apply(['slack'], '/game')).toEqual(['slack'])
  })
})
