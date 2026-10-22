import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCommitFiles, parseDiff, parseStatus } from '../server/git.ts'
import { buildServer } from '../server/main.ts'

const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs')
const FAKE_SHELL = path.resolve('tests/fixtures/fake-shell.mjs')

describe('reading git output', () => {
  it('reads porcelain v2 status: branch, counts, staged and unstaged, renames, conflicts, untracked', () => {
    const out = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 aaa bbb src/app.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.md',
      'old name.md',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? notes/todo.md',
      '',
    ].join('\0')
    expect(parseStatus(out)).toEqual({
      oid: '1234567890abcdef1234567890abcdef12345678',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      staged: [
        { path: 'src/app.ts', state: 'M' },
        { path: 'new name.md', state: 'R', from: 'old name.md' },
      ],
      changes: [
        { path: 'src/app.ts', state: 'M' },
        { path: 'notes/todo.md', state: '?' },
      ],
      conflicts: [{ path: 'conflict.txt', code: 'UU' }],
    })
    expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0')).toMatchObject({ oid: null, branch: null })
  })

  it('splits a diff into hunks with line numbers and a stable id', () => {
    const text = 'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n@@ -10 +10,2 @@\n ten\n+eleven\n\\ No newline at end of file\n'
    const d = parseDiff('a.txt', text)
    expect(d.head).toHaveLength(4)
    expect(d.hunks.map((h) => h.header)).toEqual(['@@ -1,2 +1,2 @@', '@@ -10 +10,2 @@'])
    expect(d.hunks[0].lines).toEqual([
      { kind: '-', text: 'one', old: 1 },
      { kind: '+', text: 'ONE', new: 1 },
      { kind: ' ', text: 'two', old: 2, new: 2 },
    ])
    expect(d.hunks[1].lines.at(-1)).toEqual({ kind: '\\', text: 'No newline at end of file' })
    expect(parseDiff('a.txt', text).hunks[0].id).toBe(d.hunks[0].id)
    expect(parseDiff('b.txt', text).hunks[0].id).not.toBe(d.hunks[0].id)
  })

  it('joins numstat and name-status of a commit, renames included', () => {
    const files = parseCommitFiles('3\t1\ta.txt\0' + '0\t0\t\0old.md\0new.md\0' + '-\t-\timg.png\0', 'M\0a.txt\0R100\0old.md\0new.md\0A\0img.png\0')
    expect(files).toEqual([
      { state: 'M', path: 'a.txt', added: 3, removed: 1 },
      { state: 'R', from: 'old.md', path: 'new.md', added: 0, removed: 0 },
      { state: 'A', path: 'img.png', added: null, removed: null },
    ])
  })
})

let dir: string
let home: string
let alpha: string
let remote: string
let server: Awaited<ReturnType<typeof buildServer>>
const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

const gitEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k]
  return env
}
/** Plain git in a folder, as you would in a terminal. */
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })

/** gio trash as GNOME does it, into the home Trash with a .trashinfo. */
function fakeSpawn(command: string, args: string[]) {
  if (command === 'gio' && args[0] === 'trash') {
    const trash = path.join(home, '.local/share/Trash')
    fs.mkdirSync(path.join(trash, 'files'), { recursive: true })
    fs.mkdirSync(path.join(trash, 'info'), { recursive: true })
    for (const p of args.slice(2)) {
      fs.renameSync(p, path.join(trash, 'files', path.basename(p)))
      fs.writeFileSync(path.join(trash, 'info', `${path.basename(p)}.trashinfo`), `[Trash Info]\nPath=${encodeURI(p)}\nDeletionDate=2026-10-22T10:00:00\n`)
    }
  }
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => {
    child.emit('spawn')
    child.emit('close', 0)
  })
  return child
}

const get = async (url: string, query: Record<string, string> = {}) => {
  const qs = new URLSearchParams({ profile: 'work', path: '~/alpha', ...query })
  const res = await server.app.inject({ method: 'GET', url: `${url}?${qs}`, headers })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}
const post = async (url: string, payload: object = {}, project = '~/alpha') => {
  const res = await server.app.inject({ method: 'POST', url, headers, payload: { profile: 'work', path: project, ...payload } })
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

const LINES = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(alpha, rel)), { recursive: true })
  fs.writeFileSync(path.join(alpha, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(alpha, rel), 'utf8')

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-git-')))
  home = path.join(dir, 'home')
  alpha = path.join(home, 'alpha')
  remote = path.join(dir, 'remote.git')
  for (const d of ['alpha', 'beta', 'mono/web']) await fsp.mkdir(path.join(home, d), { recursive: true })
  await fsp.writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n')
  sh(alpha, 'init', '-q')
  write('a.txt', `${LINES.join('\n')}\n`)
  write('README.md', '# Alpha\n')
  sh(alpha, 'add', '-A')
  sh(alpha, 'commit', '-q', '-m', 'First')
  sh(path.join(home, 'mono'), 'init', '-q')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'cfg/profiles/work.yaml'),
    `name: Work
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha }
      - { label: Beta, type: folder, path: ~/beta }
      - { label: Web, type: folder, path: ~/mono/web }
`,
  )
  server = await buildServer({
    configDir: path.join(dir, 'cfg'),
    port: 7420,
    distDir: null,
    home,
    watch: false,
    stateDir: path.join(dir, 'state'),
    spawn: fakeSpawn as never,
    chatCommands: { claude: FAKE_CLAUDE, shell: FAKE_SHELL },
    gitFetchEveryMs: 0,
  })
})

afterEach(async () => {
  await server.app.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

/** A bare remote with alpha pushed to it, and a second clone that plays someone else. */
function withRemote() {
  sh(dir, 'init', '-q', '--bare', remote)
  sh(alpha, 'remote', 'add', 'origin', remote)
  sh(alpha, 'push', '-q', '-u', 'origin', 'main')
  const other = path.join(dir, 'other')
  sh(dir, 'clone', '-q', remote, other)
  return other
}

describe('git per project', { timeout: 30_000 }, () => {
  it('reads the status of a project, a project inside a repository, and refuses the rest', async () => {
    write('a.txt', read('a.txt').replace('line 3\n', 'line three\n'))
    write('new.txt', 'new\n')
    sh(alpha, 'mv', 'README.md', 'READ.md')
    const { status, body } = await get('/api/git/status')
    expect(status).toBe(200)
    expect(body).toMatchObject({
      repo: '~/alpha',
      sub: '',
      branch: 'main',
      upstream: null,
      remotes: [],
      staged: [{ path: 'READ.md', from: 'README.md', state: 'R' }],
      changes: [
        { path: 'a.txt', state: 'M' },
        { path: 'new.txt', state: '?' },
      ],
      conflicts: [],
      operation: null,
      headPushed: false,
    })
    expect((await get('/api/git/status', { path: '~/mono/web' })).body).toMatchObject({ repo: '~/mono', sub: 'web/', head: null })
    expect((await get('/api/git/status', { path: '~/beta' })).status).toBe(404)
    expect((await get('/api/git/status', { path: '~/elsewhere' })).status).toBe(404)
    expect((await get('/api/git/marks', {})).body).toEqual(
      expect.arrayContaining([
        { path: '~/alpha', branch: 'main', changed: 3, ahead: 0, behind: 0, conflicts: 0 },
        { path: '~/mono/web', branch: 'main', changed: 0, ahead: 0, behind: 0, conflicts: 0 },
      ]),
    )
  })

  it('stages, unstages and discards one hunk of three, and refuses a stale hunk', async () => {
    const changed = [...LINES]
    changed[1] = 'TWO'
    changed[24] = 'TWENTY-FIVE'
    changed[47] = 'FORTY-EIGHT'
    write('a.txt', `${changed.join('\n')}\n`)
    const diff = (await get('/api/git/diff', { file: 'a.txt' })).body
    expect(diff.hunks).toHaveLength(3)
    const middle = diff.hunks[1]
    expect(middle.lines).toContainEqual({ kind: '+', text: 'TWENTY-FIVE', new: 25 })

    const staged = await post('/api/git/stage', { hunk: { file: 'a.txt', id: middle.id } })
    expect(staged.status).toBe(200)
    expect(staged.body.status.staged).toEqual([{ path: 'a.txt', state: 'M' }])
    expect(sh(alpha, 'diff', '--cached')).toContain('+TWENTY-FIVE')
    expect(sh(alpha, 'diff', '--cached')).not.toContain('TWO')
    expect((await get('/api/git/diff', { file: 'a.txt' })).body.hunks).toHaveLength(2)

    // The same id again: that hunk isn't in the unstaged diff any more.
    expect((await post('/api/git/stage', { hunk: { file: 'a.txt', id: middle.id } })).status).toBe(409)

    const cachedHunk = (await get('/api/git/diff', { file: 'a.txt', staged: '1' })).body.hunks[0]
    expect((await post('/api/git/unstage', { hunk: { file: 'a.txt', id: cachedHunk.id } })).status).toBe(200)
    expect(sh(alpha, 'diff', '--cached')).toBe('')

    const first = (await get('/api/git/diff', { file: 'a.txt' })).body.hunks[0]
    const discarded = await post('/api/git/discard', { hunk: { file: 'a.txt', id: first.id } })
    expect(discarded.status).toBe(200)
    expect(read('a.txt')).toContain('line 2\n')
    expect(read('a.txt')).toContain('TWENTY-FIVE')
    expect((await post('/api/git/undo', { undo: discarded.body.undo })).body.restored).toEqual(['a.txt'])
    expect(read('a.txt')).toContain('TWO\n')
  })

  it('discards whole files with Undo: tracked back from git, untracked from the Trash; a changed file is left alone', async () => {
    write('a.txt', 'mine\n')
    write('README.md', 'also mine\n')
    write('scratch/new.txt', 'new\n')
    const res = await post('/api/git/discard', { files: ['a.txt', 'scratch/new.txt'] })
    expect(res.status).toBe(200)
    expect(res.body.trashed).toEqual(['scratch/new.txt'])
    expect(read('a.txt')).toBe(`${LINES.join('\n')}\n`)
    expect(fs.existsSync(path.join(alpha, 'scratch/new.txt'))).toBe(false)
    expect(res.body.status.changes).toEqual([{ path: 'README.md', state: 'M' }])

    const undo = await post('/api/git/undo', { undo: res.body.undo })
    expect(undo.body.restored.sort()).toEqual(['a.txt', 'scratch/new.txt'])
    expect(read('a.txt')).toBe('mine\n')
    expect(read('scratch/new.txt')).toBe('new\n')

    const again = await post('/api/git/discard', { files: ['a.txt'] })
    write('a.txt', 'changed after the discard\n')
    expect((await post('/api/git/undo', { undo: again.body.undo })).body.skipped).toEqual([{ path: 'a.txt', reason: 'It changed since' }])
    expect(read('a.txt')).toBe('changed after the discard\n')
    expect((await post('/api/git/undo', { undo: again.body.undo })).status).toBe(404)
  })

  it('commits what is staged, amends until pushed, and drafts a message with claude', async () => {
    expect((await post('/api/git/commit', { message: 'Nothing' })).status).toBe(422)
    write('a.txt', 'changed\n')
    await post('/api/git/stage', { files: ['a.txt'] })

    const draft = await post('/api/git/draft')
    expect(draft.status).toBe(200)
    expect(draft.body.message).toMatch(/^Update a\.txt\n\nDrafted from \d+ lines; tools="".$/)

    const done = await post('/api/git/commit', { message: 'Change a\n\nWith a body.\n' })
    expect(done.body.commit).toMatchObject({ subject: 'Change a' })
    expect(done.body.status.staged).toEqual([])
    expect(sh(alpha, 'log', '-1', '--format=%B').trim()).toBe('Change a\n\nWith a body.')
    expect((await post('/api/git/commit', { message: 'Change a, better', amend: true })).status).toBe(200)
    expect(sh(alpha, 'log', '--format=%s')).toBe('Change a, better\nFirst\n')

    withRemote()
    expect((await get('/api/git/status')).body.headPushed).toBe(true)
    expect((await post('/api/git/commit', { message: 'Again', amend: true })).status).toBe(409)
  })

  it('switches, makes, renames and deletes branches; uncommitted changes ask first', async () => {
    expect((await post('/api/git/branch', { action: 'create', name: '-x' })).status).toBe(400)
    expect((await post('/api/git/branch', { action: 'create', name: 'bad..name' })).status).toBe(400)
    expect((await post('/api/git/branch', { action: 'create', name: 'feature' })).body.status.branch).toBe('feature')
    write('f.txt', 'feature\n')
    sh(alpha, 'add', 'f.txt')
    sh(alpha, 'commit', '-q', '-m', 'Feature work')
    write('a.txt', 'dirty\n')

    const ask = await post('/api/git/branch', { action: 'switch', name: 'main' })
    expect(ask.status).toBe(409)
    expect(ask.body.dirty).toBe(true)
    const stashed = await post('/api/git/branch', { action: 'switch', name: 'main', carry: 'stash' })
    expect(stashed.body.status).toMatchObject({ branch: 'main', changes: [], stashes: [{ index: 0, message: 'On feature: Before switching to main' }] })

    expect((await post('/api/git/branch', { action: 'rename', name: 'feature', to: 'feature-2' })).status).toBe(200)
    const branches = (await get('/api/git/branches')).body
    expect(branches.map((b: { name: string }) => b.name)).toEqual(['feature-2', 'main'])

    const del = await post('/api/git/branch', { action: 'delete', name: 'feature-2' })
    expect(del.status).toBe(409)
    expect(del.body).toMatchObject({ confirm: true, lost: [expect.stringMatching(/^[0-9a-f]{7} Feature work$/)] })
    expect((await post('/api/git/branch', { action: 'delete', name: 'feature-2', force: true })).status).toBe(200)
    expect((await post('/api/git/branch', { action: 'delete', name: 'main' })).status).toBe(409)
  })

  it('fetches, pulls, pushes and publishes against a remote; a diverged pull merges and can be aborted', async () => {
    const other = withRemote()
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n')
    sh(other, 'add', '-A')
    sh(other, 'commit', '-q', '-m', 'Theirs')
    sh(other, 'push', '-q')

    expect((await post('/api/git/fetch')).body.status).toMatchObject({ upstream: 'origin/main', behind: 1, lastFetch: { error: null } })
    expect((await post('/api/git/pull')).body.status.behind).toBe(0)
    expect(read('theirs.txt')).toBe('theirs\n')

    write('a.txt', 'ours\n')
    sh(alpha, 'commit', '-qam', 'Ours')
    fs.writeFileSync(path.join(other, 'a.txt'), 'their a\n')
    sh(other, 'commit', '-qam', 'Their a')
    sh(other, 'push', '-q')
    expect((await post('/api/git/push')).status).toBe(409)
    await post('/api/git/fetch')
    const diverged = await post('/api/git/pull')
    expect(diverged.status).toBe(409)
    expect(diverged.body.diverged).toBe(true)

    const merged = await post('/api/git/pull', { merge: true })
    expect(merged.body.conflicts).toBe(true)
    expect(merged.body.status).toMatchObject({ operation: 'merge', operationLabel: expect.stringContaining('Merge branch'), conflicts: [{ path: 'a.txt', code: 'UU' }] })
    expect((await get('/api/git/diff', { file: 'a.txt' })).body.hunks[0].lines.map((l: { text: string }) => l.text)).toContain('<<<<<<< HEAD')
    expect((await post('/api/git/resolve', { file: 'a.txt' })).body).toMatchObject({ confirm: true })
    expect((await post('/api/git/abort')).body.status).toMatchObject({ operation: null, conflicts: [], ahead: 1, behind: 1 })

    sh(alpha, 'switch', '-q', '-c', 'topic')
    const publish = await post('/api/git/push')
    expect(publish.status).toBe(409)
    expect(publish.body).toMatchObject({ publish: true, remote: 'origin' })
    expect((await post('/api/git/push', { publish: true })).body.status).toMatchObject({ upstream: 'origin/topic', ahead: 0 })
    expect(sh(remote, 'branch', '--list', 'topic')).toContain('topic')
  })

  it('a conflict can be marked resolved, and Ask claude starts a chat about it', async () => {
    const other = withRemote()
    write('a.txt', 'ours\n')
    sh(alpha, 'commit', '-qam', 'Ours')
    fs.writeFileSync(path.join(other, 'a.txt'), 'theirs\n')
    sh(other, 'commit', '-qam', 'Theirs')
    sh(other, 'push', '-q')
    await post('/api/git/fetch')
    await post('/api/git/pull', { merge: true })

    const chat = await post('/api/git/ask', { files: ['a.txt', 'README.md'] })
    expect(chat.status).toBe(200)
    expect(chat.body).toMatchObject({ label: 'Conflicts', host: expect.any(String) })
    await expect.poll(() => server.chats.text(chat.body.id), { timeout: 5000 }).toContain('prompt=This repository has merge conflicts')
    expect(server.chats.text(chat.body.id)).toContain('Resolve the conflicts in a.txt (')
    expect(server.chats.text(chat.body.id)).not.toContain('README.md')
    await server.chats.close(chat.body.id)

    write('a.txt', 'both\n')
    const done = await post('/api/git/resolve', { file: 'a.txt' })
    expect(done.body.status).toMatchObject({ conflicts: [], staged: [{ path: 'a.txt', state: 'M' }] })
    expect((await post('/api/git/commit', { message: 'Merge' })).status).toBe(200)
  })

  it('stashes and pops; a pop that conflicts keeps the stash', async () => {
    expect((await post('/api/git/stash', { action: 'push' })).status).toBe(422)
    write('a.txt', 'stashed\n')
    const pushed = (await post('/api/git/stash', { action: 'push', message: 'wip' })).body.status
    expect(pushed.changes).toEqual([])
    const [s] = pushed.stashes
    expect(s).toMatchObject({ index: 0, message: 'On main: wip' })
    expect((await post('/api/git/stash', { action: 'pop', index: 0, hash: 'f'.repeat(40) })).status).toBe(409)

    write('a.txt', 'conflicting\n')
    sh(alpha, 'commit', '-qam', 'Meanwhile')
    const popped = await post('/api/git/stash', { action: 'pop', index: 0, hash: s.hash })
    expect(popped.body.conflicts).toBe(true)
    expect(popped.body.status).toMatchObject({ operation: 'stash', conflicts: [{ path: 'a.txt' }], stashes: [{ hash: s.hash }] })
  })

  it('lists history and shows a commit with its files and diffs', async () => {
    write('a.txt', read('a.txt').replace('line 10\n', 'line ten\n'))
    sh(alpha, 'mv', 'README.md', 'READ.md')
    sh(alpha, 'commit', '-qam', 'Second\n\nThe body.')
    const log = (await get('/api/git/log')).body
    expect(log.map((c: { subject: string }) => c.subject)).toEqual(['Second', 'First'])
    expect((await get('/api/git/log', { skip: '1' })).body).toHaveLength(1)

    const detail = (await get('/api/git/commit', { hash: log[0].short })).body
    expect(detail).toMatchObject({ subject: 'Second', body: 'The body.', parents: [log[1].hash] })
    expect(detail.files).toEqual([
      { state: 'R', from: 'README.md', path: 'READ.md', added: 0, removed: 0 },
      { state: 'M', path: 'a.txt', added: 1, removed: 1 },
    ])
    const fileDiff = (await get('/api/git/commit', { hash: log[0].hash, file: 'a.txt' })).body
    expect(fileDiff.hunks[0].lines).toContainEqual({ kind: '+', text: 'line ten', new: 10 })
    expect((await get('/api/git/commit', { hash: log[1].hash })).body.files).toHaveLength(2)
    expect((await get('/api/git/commit', { hash: 'zzzz' })).status).toBe(400)
    expect((await get('/api/git/commit', { hash: 'abcdef12' })).status).toBe(404)
    expect((await get('/api/git/log', { path: '~/mono/web' })).body).toEqual([])
  })

  it('never runs a repository’s fsmonitor program, and checks every path it is given', async () => {
    const pwned = path.join(dir, 'pwned')
    fs.writeFileSync(path.join(dir, 'monitor.sh'), `#!/bin/sh\ntouch ${pwned}\nexit 1\n`, { mode: 0o755 })
    sh(alpha, 'config', 'core.fsmonitor', path.join(dir, 'monitor.sh'))
    write('a.txt', 'x\n')
    // Plain git in a terminal runs it…
    sh(alpha, 'status', '--porcelain')
    expect(fs.existsSync(pwned)).toBe(true)
    fs.rmSync(pwned)
    // …the app never does.
    await get('/api/git/status')
    await get('/api/git/marks', {})
    await get('/api/git/diff', { file: 'a.txt' })
    await post('/api/git/stage', { files: ['a.txt'] })
    expect(fs.existsSync(pwned)).toBe(false)

    expect((await get('/api/git/diff', { file: '../outside.txt' })).status).toBe(400)
    expect((await get('/api/git/diff', { file: '/etc/passwd' })).status).toBe(400)
    expect((await post('/api/git/stage', { files: ['README.md'] })).status).toBe(409)
    expect((await post('/api/git/discard', { files: ['nothing.txt'] })).status).toBe(409)
    expect((await post('/api/git/stage', { hunk: { file: 'a.txt', id: 'not-a-hunk' } })).status).toBe(400)
  })
})
