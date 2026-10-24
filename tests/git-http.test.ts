import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../server/main.ts'
import { migrateFixture } from './fixtures/wiki.ts'

let dir: string
let home: string
let alpha: string
let other: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

const sh = (cwd: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' })
}

const start = async (fetchEveryMs = 0) => {
  await migrateFixture(path.join(dir, 'cfg'), home)
  return buildServer({ dir: path.join(home, 'wb'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), gitFetchEveryMs: fetchEveryMs })
}

const status = async () => {
  const res = await server.app.inject({ method: 'GET', url: '/api/git/status?profile=work&path=~/alpha', headers })
  return JSON.parse(res.body)
}

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-git-http-')))
  home = path.join(dir, 'home')
  alpha = path.join(home, 'alpha')
  other = path.join(dir, 'other')
  await fsp.mkdir(alpha, { recursive: true })
  await fsp.writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
  sh(dir, 'init', '-q', '--bare', 'remote.git')
  sh(alpha, 'init', '-q')
  fs.writeFileSync(path.join(alpha, 'a.txt'), 'a\n')
  sh(alpha, 'add', '-A')
  sh(alpha, 'commit', '-q', '-m', 'First')
  sh(alpha, 'remote', 'add', 'origin', path.join(dir, 'remote.git'))
  sh(alpha, 'push', '-q', '-u', 'origin', 'main')
  sh(dir, 'clone', '-q', 'remote.git', other)
  sh(other, 'switch', '-q', '-c', 'feature')
  fs.writeFileSync(path.join(other, 'f.txt'), 'f\n')
  sh(other, 'add', '-A')
  sh(other, 'commit', '-q', '-m', 'Feature')
  sh(other, 'push', '-q', '-u', 'origin', 'feature')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), 'name: Work\nsections:\n  - title: Projects\n    items:\n      - { label: Alpha, type: folder, path: ~/alpha }\n')
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('git routes', { timeout: 30_000 }, () => {
  it('need the guard header, a known profile and project, and valid fields', async () => {
    server = await start()
    const plain = await server.app.inject({ method: 'GET', url: '/api/git/status?profile=work&path=~/alpha', headers: { host: '127.0.0.1:7420' } })
    expect(plain.statusCode).toBe(403)
    const bad = (payload: object) => server.app.inject({ method: 'POST', url: '/api/git/branch', headers, payload: { profile: 'work', path: '~/alpha', ...payload } })
    expect((await bad({ action: 'explode', name: 'x' })).statusCode).toBe(400)
    expect((await bad({ action: 'switch', name: 'nope' })).statusCode).toBe(404)
    const missing = await server.app.inject({ method: 'GET', url: '/api/git/status?profile=nobody&path=~/alpha', headers })
    expect(missing.statusCode).toBe(404)
    const unknown = await server.app.inject({ method: 'GET', url: `/api/git/status?profile=work&path=${encodeURIComponent(dir)}`, headers })
    expect(unknown.statusCode).toBe(404)
  })

  it('switches to a remote branch by making a local one that tracks it', async () => {
    server = await start()
    await server.app.inject({ method: 'POST', url: '/api/git/fetch', headers, payload: { profile: 'work', path: '~/alpha' } })
    const list = JSON.parse((await server.app.inject({ method: 'GET', url: '/api/git/branches?profile=work&path=~/alpha', headers })).body)
    expect(list.map((b: { name: string; remote: boolean }) => `${b.remote ? 'remote' : 'local'} ${b.name}`)).toEqual(['local main', 'remote origin/feature', 'remote origin/main'])
    const res = await server.app.inject({ method: 'POST', url: '/api/git/branch', headers, payload: { profile: 'work', path: '~/alpha', action: 'switch', name: 'origin/feature' } })
    expect(JSON.parse(res.body).status).toMatchObject({ branch: 'feature', upstream: 'origin/feature', ahead: 0, behind: 0 })
    expect(fs.existsSync(path.join(alpha, 'f.txt'))).toBe(true)
  })

  it('fetches the active profile’s repositories in the background, quietly', async () => {
    fs.writeFileSync(path.join(other, 'f.txt'), 'f2\n')
    sh(other, 'commit', '-qam', 'More')
    sh(other, 'push', '-q')
    server = await start(300)
    // Nothing fetched until the timer's first round.
    expect((await status()).lastFetch).toBeNull()
    await expect.poll(async () => (await status()).lastFetch?.error, { timeout: 5000 }).toBeNull()
    expect(sh(alpha, 'branch', '-r', '-v')).toContain('More')
    // A broken remote is noted on the tab, not thrown.
    sh(alpha, 'remote', 'set-url', 'origin', path.join(dir, 'gone.git'))
    await expect.poll(async () => (await status()).lastFetch?.error ?? '', { timeout: 5000 }).toMatch(/gone\.git|does not appear|not a git repository/)
  })
})
