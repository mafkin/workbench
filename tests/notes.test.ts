import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../server/config-store.ts'
import { buildServer } from '../server/main.ts'
import { Notes } from '../server/notes.ts'

let dir: string
let home: string
let store: ConfigStore
let notes: Notes

const WORK = `name: Work
notes: ~/notes
sections:
  - title: Docs
    items:
      - { label: Runbook, type: note, path: ~/outside/RUNBOOK.md }
      - label: Deploy
        type: group
        items:
          - { label: Plan, type: note, path: ~/outside/deep/plan.txt }
`

const PERSONAL = `name: Personal
notes: ~/pnotes
sections: []
`

const BARE = `name: Bare
sections: []
`

async function write(rel: string, text: string) {
  const file = path.join(home, rel)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text)
  return file
}

/** The status of a rejected call: StoreError carries one. */
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
  return 200
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-notes-'))
  home = path.join(dir, 'home')
  await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'cfg/profiles/work.yaml'), WORK)
  await fsp.writeFile(path.join(dir, 'cfg/profiles/personal.yaml'), PERSONAL)
  await fsp.writeFile(path.join(dir, 'cfg/profiles/bare.yaml'), BARE)
  await write('notes/Ideas.md', '# Ideas\n\nShip the notes part.\n')
  await write('notes/sub/Deploy plan.md', '# Deploy plan\n\nTag the release, then deploy.\n')
  await write('notes/.trash/Old.md', 'old deploy notes\n')
  await write('notes/data.txt', 'not markdown\n')
  await write('notes/pic.png', 'PNG')
  await write('outside/RUNBOOK.md', '# Runbook\n\nDeploy steps.\n')
  await write('outside/other.md', 'secret sibling\n')
  await write('outside/diagram.svg', '<svg/>')
  await write('outside/deep/plan.txt', 'plain text plan\n')
  await write('secret.md', 'top secret\n')
  await write('private/hidden.md', 'hidden\n')
  await write('pnotes/Personal.md', 'personal\n')
  store = new ConfigStore(path.join(dir, 'cfg'))
  await store.init({ watch: false })
  notes = new Notes(store, home)
})

afterEach(async () => {
  notes.close()
  store.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('which files notes may touch', () => {
  it('reads a note in the notes folder, by ~ or absolute path', async () => {
    const note = await notes.read('work', '~/notes/Ideas.md')
    expect(note.path).toBe('~/notes/Ideas.md')
    expect(note.text).toContain('Ship the notes part')
    expect(note.rev).toMatch(/^[0-9a-f]{12}$/)
    expect((await notes.read('work', path.join(home, 'notes/sub/Deploy plan.md'))).path).toBe('~/notes/sub/Deploy plan.md')
  })

  it('reads note entries outside the notes folder, whatever their extension', async () => {
    expect((await notes.read('work', '~/outside/RUNBOOK.md')).text).toContain('Deploy steps')
    expect((await notes.read('work', '~/outside/deep/plan.txt')).text).toContain('plain text plan')
  })

  it('refuses .. out of the notes folder', async () => {
    expect(await status(notes.read('work', '~/notes/../secret.md'))).toBe(403)
    expect(await status(notes.read('work', '~/notes/sub/../../secret.md'))).toBe(403)
  })

  it('refuses a sibling of a note entry', async () => {
    expect(await status(notes.read('work', '~/outside/other.md'))).toBe(403)
  })

  it('refuses files in the notes folder that are not Markdown', async () => {
    expect(await status(notes.read('work', '~/notes/data.txt'))).toBe(403)
    expect(await status(notes.write('work', '~/notes/run.sh', null, 'echo'))).toBe(403)
  })

  it('refuses symlinks that lead out of the notes folder', async () => {
    await fsp.symlink(path.join(home, 'secret.md'), path.join(home, 'notes/link.md'))
    await fsp.symlink(path.join(home, 'private'), path.join(home, 'notes/linked-dir'))
    await fsp.symlink(path.join(home, 'nowhere/new.md'), path.join(home, 'notes/dangling.md'))
    expect(await status(notes.read('work', '~/notes/link.md'))).toBe(403)
    expect(await status(notes.read('work', '~/notes/linked-dir/hidden.md'))).toBe(403)
    expect(await status(notes.write('work', '~/notes/linked-dir/new.md', null, 'x'))).toBe(403)
    expect(await status(notes.write('work', '~/notes/dangling.md', null, 'x'))).toBe(403)
    expect(fs.existsSync(path.join(home, 'nowhere/new.md'))).toBe(false)
  })

  it("refuses another profile's notes folder", async () => {
    expect(await status(notes.read('work', '~/pnotes/Personal.md'))).toBe(403)
    expect((await notes.read('personal', '~/pnotes/Personal.md')).text).toBe('personal\n')
  })

  it('needs a notes folder for anything but note entries', async () => {
    expect(await status(notes.read('bare', '~/notes/Ideas.md'))).toBe(403)
  })

  it('refuses relative paths and unknown profiles', async () => {
    expect(await status(notes.read('work', 'notes/Ideas.md'))).toBe(400)
    expect(await status(notes.read('nobody', '~/notes/Ideas.md'))).toBe(404)
  })

  it('reports a missing note in the notes folder as 404', async () => {
    expect(await status(notes.read('work', '~/notes/Missing.md'))).toBe(404)
  })
})

describe('writing', () => {
  it('saves against the rev it started from and returns the new rev', async () => {
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    const saved = await notes.write('work', '~/notes/Ideas.md', rev, '# Ideas\n\nChanged.\n')
    expect(saved.rev).not.toBe(rev)
    expect(await fsp.readFile(path.join(home, 'notes/Ideas.md'), 'utf8')).toBe('# Ideas\n\nChanged.\n')
    expect((await notes.read('work', '~/notes/Ideas.md')).rev).toBe(saved.rev)
  })

  it('refuses a stale rev with 409 and the current rev', async () => {
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    await fsp.writeFile(path.join(home, 'notes/Ideas.md'), 'edited by hand\n')
    const err = await notes.write('work', '~/notes/Ideas.md', rev, 'mine').catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.data.rev).toBe((await notes.read('work', '~/notes/Ideas.md')).rev)
    expect(await fsp.readFile(path.join(home, 'notes/Ideas.md'), 'utf8')).toBe('edited by hand\n')
  })

  it('reports a note deleted on disk as a conflict with rev null', async () => {
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    await fsp.rm(path.join(home, 'notes/Ideas.md'))
    const err = await notes.write('work', '~/notes/Ideas.md', rev, 'mine').catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.data.rev).toBeNull()
  })

  it('creates with rev null, making folders, but never over an existing file', async () => {
    await notes.write('work', '~/notes/new/deeper/Fresh.md', null, '# Fresh\n')
    expect(await fsp.readFile(path.join(home, 'notes/new/deeper/Fresh.md'), 'utf8')).toBe('# Fresh\n')
    expect(await status(notes.write('work', '~/notes/Ideas.md', null, 'overwrite'))).toBe(409)
    expect(await fsp.readFile(path.join(home, 'notes/Ideas.md'), 'utf8')).toContain('Ship the notes part')
  })

  it('creates the notes folder itself when it does not exist yet', async () => {
    await fsp.rm(path.join(home, 'notes'), { recursive: true })
    await notes.write('work', '~/notes/First.md', null, '# First\n')
    expect(await fsp.readFile(path.join(home, 'notes/First.md'), 'utf8')).toBe('# First\n')
  })

  it('leaves no temp files and keeps the file mode', async () => {
    const file = path.join(home, 'notes/Ideas.md')
    await fsp.chmod(file, 0o600)
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    await notes.write('work', '~/notes/Ideas.md', rev, 'x')
    expect((await fsp.readdir(path.join(home, 'notes'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
  })

  it('writes through a symlinked note entry without replacing the link', async () => {
    await fsp.rm(path.join(home, 'outside/RUNBOOK.md'))
    await write('real/RUNBOOK.md', 'real\n')
    await fsp.symlink(path.join(home, 'real/RUNBOOK.md'), path.join(home, 'outside/RUNBOOK.md'))
    const { rev } = await notes.read('work', '~/outside/RUNBOOK.md')
    await notes.write('work', '~/outside/RUNBOOK.md', rev, 'updated\n')
    expect((await fsp.lstat(path.join(home, 'outside/RUNBOOK.md'))).isSymbolicLink()).toBe(true)
    expect(await fsp.readFile(path.join(home, 'real/RUNBOOK.md'), 'utf8')).toBe('updated\n')
  })

  it('serializes concurrent saves so only one wins a rev', async () => {
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    const results = await Promise.allSettled([
      notes.write('work', '~/notes/Ideas.md', rev, 'one'),
      notes.write('work', '~/notes/Ideas.md', rev, 'two'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('list and search', () => {
  it('lists Markdown in the notes folder (skipping dot-folders) plus note entries', async () => {
    const list = await notes.list('work')
    const byPath = Object.fromEntries(list.map((n) => [n.path, n]))
    expect(Object.keys(byPath).sort()).toEqual([
      '~/notes/Ideas.md',
      '~/notes/sub/Deploy plan.md',
      '~/outside/RUNBOOK.md',
      '~/outside/deep/plan.txt',
    ])
    expect(byPath['~/notes/sub/Deploy plan.md']).toMatchObject({ name: 'Deploy plan', rel: 'sub/Deploy plan.md' })
    expect(byPath['~/outside/RUNBOOK.md']).toMatchObject({ name: 'RUNBOOK', rel: null })
  })

  it('lists newest first', async () => {
    const old = new Date('2020-01-01')
    await fsp.utimes(path.join(home, 'notes/Ideas.md'), old, old)
    const list = await notes.list('work')
    expect(list.at(-1)?.path).toBe('~/notes/Ideas.md')
  })

  it('lists only note entries without a notes folder', async () => {
    expect(await notes.list('bare')).toEqual([])
  })

  it('finds notes containing every word, case-insensitively, title matches first', async () => {
    const hits = await notes.search('work', 'DEPLOY')
    expect(hits.map((h) => h.path)).toEqual(['~/notes/sub/Deploy plan.md', '~/outside/RUNBOOK.md'])
    expect(hits[0].title).toBe(true)
    const line = hits[1].lines[0]
    expect(line.text.slice(line.ranges[0][0], line.ranges[0][1])).toBe('Deploy')
    expect((await notes.search('work', 'tag deploy')).map((h) => h.path)).toEqual(['~/notes/sub/Deploy plan.md'])
    expect(await notes.search('work', 'nothing-matches-this')).toEqual([])
  })

  it('caps snippets per note and trims long lines around the match', async () => {
    await write('notes/Long.md', `${'x'.repeat(500)} needle ${'y'.repeat(500)}\nneedle\nneedle\nneedle\n`)
    const [hit] = await notes.search('work', 'needle')
    expect(hit.lines).toHaveLength(3)
    expect(hit.lines[0].text.length).toBeLessThan(260)
    const [s, e] = hit.lines[0].ranges[0]
    expect(hit.lines[0].text.slice(s, e)).toBe('needle')
  })

  it('an empty query lists notes without snippets', async () => {
    const hits = await notes.search('work', '  ')
    expect(hits).toHaveLength(4)
    expect(hits.every((h) => h.lines.length === 0)).toBe(true)
  })
})

describe('images', () => {
  it('serves images in the notes folder and next to note entries', async () => {
    expect(await notes.asset('work', '~/notes/pic.png')).toMatchObject({ type: 'image/png' })
    expect(await notes.asset('work', '~/outside/diagram.svg')).toMatchObject({ type: 'image/svg+xml' })
  })

  it('refuses non-images and images elsewhere', async () => {
    expect(await status(notes.asset('work', '~/notes/Ideas.md'))).toBe(403)
    await write('elsewhere/pic.png', 'PNG')
    expect(await status(notes.asset('work', '~/elsewhere/pic.png'))).toBe(403)
  })
})

describe('watching', () => {
  it('reports a hand edit to a note that was opened', async () => {
    await notes.read('work', '~/notes/Ideas.md')
    const event = new Promise<{ path: string; rev: string | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no note event')), 3000)
      notes.on('note', (e) => {
        clearTimeout(t)
        resolve(e)
      })
    })
    await fsp.writeFile(path.join(home, 'notes/Ideas.md'), 'by hand\n')
    const e = await event
    expect(e.path).toBe('~/notes/Ideas.md')
    expect(e.rev).toBe((await notes.read('work', '~/notes/Ideas.md')).rev)
  })
})

describe('watching a folder that was replaced', () => {
  it('watches again after the folder is deleted and made anew', async () => {
    await notes.read('work', '~/notes/Ideas.md')
    await fsp.rm(path.join(home, 'notes'), { recursive: true })
    await write('notes/Ideas.md', 'again\n')
    await notes.read('work', '~/notes/Ideas.md')
    // Let events from the delete settle, so only the hand edit below can pass this test.
    await new Promise((r) => setTimeout(r, 300))
    const event = new Promise<{ path: string; rev: string | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no note event')), 3000)
      notes.on('note', (e) => {
        clearTimeout(t)
        resolve(e)
      })
    })
    await fsp.writeFile(path.join(home, 'notes/Ideas.md'), 'by hand\n')
    expect(await event).toEqual({ path: '~/notes/Ideas.md', rev: (await notes.read('work', '~/notes/Ideas.md')).rev })
  })
})

describe('saves are reported', () => {
  it('emits the new rev so other windows can follow', async () => {
    const { rev } = await notes.read('work', '~/notes/Ideas.md')
    const events: unknown[] = []
    notes.on('note', (e) => events.push(e))
    const saved = await notes.write('work', '~/notes/Ideas.md', rev, 'new')
    expect(events).toEqual([{ path: '~/notes/Ideas.md', rev: saved.rev }])
  })
})

describe('HTTP routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  beforeEach(async () => {
    server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, watch: false })
  })

  afterEach(() => server.app.close())

  const get = (url: string, h: Record<string, string> = headers) => server.app.inject({ method: 'GET', url, headers: h })
  const q = (p: string) => encodeURIComponent(p)

  it('every notes route needs the X-Workbench header', async () => {
    const bare = { host: '127.0.0.1:7420' }
    for (const url of [
      `/api/notes/file?profile=work&path=${q('~/notes/Ideas.md')}`,
      '/api/notes/list?profile=work',
      '/api/notes/search?profile=work&q=x',
      `/api/notes/asset?profile=work&path=${q('~/notes/pic.png')}`,
    ]) {
      expect((await get(url, bare)).statusCode).toBe(403)
    }
    const post = await server.app.inject({
      method: 'POST',
      url: '/api/notes/file',
      headers: bare,
      payload: { profile: 'work', path: '~/notes/X.md', rev: null, text: 'x' },
    })
    expect(post.statusCode).toBe(403)
  })

  it('reads, saves and reports conflicts with the current rev', async () => {
    const read = await get(`/api/notes/file?profile=work&path=${q('~/notes/Ideas.md')}`)
    expect(read.statusCode).toBe(200)
    const { rev } = read.json()
    const save = (r: string | null, text: string) =>
      server.app.inject({ method: 'POST', url: '/api/notes/file', headers, payload: { profile: 'work', path: '~/notes/Ideas.md', rev: r, text } })
    const ok = await save(rev, 'v2')
    expect(ok.statusCode).toBe(200)
    const stale = await save(rev, 'v3')
    expect(stale.statusCode).toBe(409)
    expect(stale.json().rev).toBe(ok.json().rev)
  })

  it('maps refusals to 403 and validates the body', async () => {
    expect((await get(`/api/notes/file?profile=work&path=${q('~/secret.md')}`)).statusCode).toBe(403)
    const bad = await server.app.inject({ method: 'POST', url: '/api/notes/file', headers, payload: { profile: 'work' } })
    expect(bad.statusCode).toBe(400)
  })

  it('serves images sandboxed with their type', async () => {
    const res = await get(`/api/notes/asset?profile=work&path=${q('~/outside/diagram.svg')}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/svg+xml')
    expect(res.headers['content-security-policy']).toBe('sandbox')
    expect(res.body).toBe('<svg/>')
  })

  it('includes the home directory in the state', async () => {
    expect((await get('/api/state')).json().home).toBe(home)
  })
})
