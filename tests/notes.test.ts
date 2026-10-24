import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wiki } from '../server/wiki.ts'
import { migrateFixture } from './fixtures/wiki.ts'
import { buildServer } from '../server/main.ts'
import { Notes } from '../server/notes.ts'

let dir: string
let home: string
let store: Wiki
let notes: Notes

const WORK = `name: Work
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
  await write('wb/work/Ideas.md', '# Ideas\n\nShip the notes part.\n')
  await write('wb/work/sub/Deploy plan.md', '# Deploy plan\n\nTag the release, then deploy.\n')
  await write('wb/work/.trash/Old.md', 'old deploy notes\n')
  await write('wb/work/data.txt', 'not markdown\n')
  await write('wb/work/pic.png', 'PNG')
  await write('outside/RUNBOOK.md', '# Runbook\n\nDeploy steps.\n')
  await write('outside/other.md', 'secret sibling\n')
  await write('outside/diagram.svg', '<svg/>')
  await write('outside/deep/plan.txt', 'plain text plan\n')
  await write('secret.md', 'top secret\n')
  await write('private/hidden.md', 'hidden\n')
  await write('wb/personal/Personal.md', 'personal\n')
  await migrateFixture(path.join(dir, 'cfg'), home)
  store = new Wiki(path.join(home, 'wb'), home)
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
    const note = await notes.read('work', '~/wb/work/Ideas.md')
    expect(note.path).toBe('~/wb/work/Ideas.md')
    expect(note.text).toContain('Ship the notes part')
    expect(note.rev).toMatch(/^[0-9a-f]{12}$/)
    expect((await notes.read('work', path.join(home, 'wb/work/sub/Deploy plan.md'))).path).toBe('~/wb/work/sub/Deploy plan.md')
  })

  it('reads note entries outside the notes folder, whatever their extension', async () => {
    expect((await notes.read('work', '~/outside/RUNBOOK.md')).text).toContain('Deploy steps')
    expect((await notes.read('work', '~/outside/deep/plan.txt')).text).toContain('plain text plan')
  })

  it('refuses .. out of the notes folder', async () => {
    expect(await status(notes.read('work', '~/wb/work/../../secret.md'))).toBe(403)
    expect(await status(notes.read('work', '~/wb/work/sub/../../../secret.md'))).toBe(403)
  })

  it('refuses a sibling of a note entry', async () => {
    expect(await status(notes.read('work', '~/outside/other.md'))).toBe(403)
  })

  it('refuses files in the notes folder that are not Markdown', async () => {
    expect(await status(notes.read('work', '~/wb/work/data.txt'))).toBe(403)
    expect(await status(notes.write('work', '~/wb/work/run.sh', null, 'echo'))).toBe(403)
  })

  it('refuses symlinks that lead out of the notes folder', async () => {
    await fsp.symlink(path.join(home, 'secret.md'), path.join(home, 'wb/work/link.md'))
    await fsp.symlink(path.join(home, 'private'), path.join(home, 'wb/work/linked-dir'))
    await fsp.symlink(path.join(home, 'nowhere/new.md'), path.join(home, 'wb/work/dangling.md'))
    expect(await status(notes.read('work', '~/wb/work/link.md'))).toBe(403)
    expect(await status(notes.read('work', '~/wb/work/linked-dir/hidden.md'))).toBe(403)
    expect(await status(notes.write('work', '~/wb/work/linked-dir/new.md', null, 'x'))).toBe(403)
    expect(await status(notes.write('work', '~/wb/work/dangling.md', null, 'x'))).toBe(403)
    expect(fs.existsSync(path.join(home, 'nowhere/new.md'))).toBe(false)
  })

  it("reaches another profile's folder (it is inside the Workbench), but nothing outside it", async () => {
    expect((await notes.read('work', '~/wb/personal/Personal.md')).text).toBe('personal\n')
    expect((await notes.read('personal', '~/wb/personal/Personal.md')).text).toBe('personal\n')
    expect(await status(notes.read('work', '~/secret.md'))).toBe(403)
  })

  it('a profile without entries still has its own folder and the Workbench', async () => {
    expect((await notes.read('bare', '~/wb/work/Ideas.md')).text).toContain('Ideas')
    expect(await status(notes.read('bare', '~/private/hidden.md'))).toBe(403)
  })

  it('refuses relative paths and unknown profiles', async () => {
    expect(await status(notes.read('work', 'notes/Ideas.md'))).toBe(400)
    expect(await status(notes.read('nobody', '~/wb/work/Ideas.md'))).toBe(404)
  })

  it('reports a missing note in the notes folder as 404', async () => {
    expect(await status(notes.read('work', '~/wb/work/Missing.md'))).toBe(404)
  })
})

describe('writing', () => {
  it('saves against the rev it started from and returns the new rev', async () => {
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    const saved = await notes.write('work', '~/wb/work/Ideas.md', rev, '# Ideas\n\nChanged.\n')
    expect(saved.rev).not.toBe(rev)
    expect(await fsp.readFile(path.join(home, 'wb/work/Ideas.md'), 'utf8')).toBe('# Ideas\n\nChanged.\n')
    expect((await notes.read('work', '~/wb/work/Ideas.md')).rev).toBe(saved.rev)
  })

  it('refuses a stale rev with 409 and the current rev', async () => {
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    await fsp.writeFile(path.join(home, 'wb/work/Ideas.md'), 'edited by hand\n')
    const err = await notes.write('work', '~/wb/work/Ideas.md', rev, 'mine').catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.data.rev).toBe((await notes.read('work', '~/wb/work/Ideas.md')).rev)
    expect(await fsp.readFile(path.join(home, 'wb/work/Ideas.md'), 'utf8')).toBe('edited by hand\n')
  })

  it('reports a note deleted on disk as a conflict with rev null', async () => {
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    await fsp.rm(path.join(home, 'wb/work/Ideas.md'))
    const err = await notes.write('work', '~/wb/work/Ideas.md', rev, 'mine').catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.data.rev).toBeNull()
  })

  it('creates with rev null, making folders, but never over an existing file', async () => {
    await notes.write('work', '~/wb/work/new/deeper/Fresh.md', null, '# Fresh\n')
    expect(await fsp.readFile(path.join(home, 'wb/work/new/deeper/Fresh.md'), 'utf8')).toBe('# Fresh\n')
    expect(await status(notes.write('work', '~/wb/work/Ideas.md', null, 'overwrite'))).toBe(409)
    expect(await fsp.readFile(path.join(home, 'wb/work/Ideas.md'), 'utf8')).toContain('Ship the notes part')
  })

  it('leaves no temp files and keeps the file mode', async () => {
    const file = path.join(home, 'wb/work/Ideas.md')
    await fsp.chmod(file, 0o600)
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    await notes.write('work', '~/wb/work/Ideas.md', rev, 'x')
    expect((await fsp.readdir(path.join(home, 'wb/work'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
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
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    const results = await Promise.allSettled([
      notes.write('work', '~/wb/work/Ideas.md', rev, 'one'),
      notes.write('work', '~/wb/work/Ideas.md', rev, 'two'),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
  })
})

describe('list and search', () => {
  it('lists Markdown in the notes folder (skipping dot-folders) plus note entries', async () => {
    const list = await notes.list('work')
    const byPath = Object.fromEntries(list.map((n) => [n.path, n]))
    expect(Object.keys(byPath).sort()).toEqual([
      '~/outside/RUNBOOK.md',
      '~/outside/deep/plan.txt',
      '~/wb/work/Ideas.md',
      '~/wb/work/index.md',
      '~/wb/work/sub/Deploy plan.md',
    ])
    expect(byPath['~/wb/work/sub/Deploy plan.md']).toMatchObject({ name: 'Deploy plan', rel: 'sub/Deploy plan.md' })
    expect(byPath['~/outside/RUNBOOK.md']).toMatchObject({ name: 'RUNBOOK', rel: null })
  })

  it('lists newest first', async () => {
    const old = new Date('2020-01-01')
    await fsp.utimes(path.join(home, 'wb/work/Ideas.md'), old, old)
    const list = await notes.list('work')
    expect(list.at(-1)?.path).toBe('~/wb/work/Ideas.md')
  })

  it('a profile’s wiki is its notes folder: a bare one lists its index page', async () => {
    expect((await notes.list('bare')).map((n) => n.name)).toEqual(['index'])
  })

  it('finds notes containing every word, case-insensitively, title matches first', async () => {
    const hits = await notes.search('work', 'DEPLOY')
    // index.md names the Deploy group, so it is a hit too.
    expect(hits.map((h) => h.path)).toEqual(['~/wb/work/sub/Deploy plan.md', '~/wb/work/index.md', '~/outside/RUNBOOK.md'])
    expect(hits[0].title).toBe(true)
    const line = hits[2].lines[0]
    expect(line.text.slice(line.ranges[0][0], line.ranges[0][1])).toBe('Deploy')
    expect((await notes.search('work', 'tag deploy')).map((h) => h.path)).toEqual(['~/wb/work/sub/Deploy plan.md'])
    expect(await notes.search('work', 'nothing-matches-this')).toEqual([])
  })

  it('a #word in the query is a tag: notes carrying it in tags: or their text, not a heading', async () => {
    await write('wb/work/Tagged.md', '---\ntags: [deploy]\n---\n# Tagged\n\nNothing else.\n')
    await write('wb/work/Inline.md', '# Inline\n\nRemember the #deploy checklist, and #Review it.\n')
    await write('wb/work/Heading.md', '# deploy\n\nA heading is not a tag.\n')
    expect((await notes.search('work', '#deploy')).map((h) => h.path).sort()).toEqual(['~/wb/work/Inline.md', '~/wb/work/Tagged.md'])
    const [inline] = await notes.search('work', '#Deploy checklist')
    expect(inline.path).toBe('~/wb/work/Inline.md')
    expect(inline.lines[0].ranges).toHaveLength(2)
    expect(await notes.search('work', '#review #deploy')).toHaveLength(1)
    expect(await notes.search('work', '#nothing')).toEqual([])
    // A lone # is text, not an empty tag.
    expect((await notes.search('work', '#')).length).toBeGreaterThan(0)
  })

  it('caps snippets per note and trims long lines around the match', async () => {
    await write('wb/work/Long.md', `${'x'.repeat(500)} needle ${'y'.repeat(500)}\nneedle\nneedle\nneedle\n`)
    const [hit] = await notes.search('work', 'needle')
    expect(hit.lines).toHaveLength(3)
    expect(hit.lines[0].text.length).toBeLessThan(260)
    const [s, e] = hit.lines[0].ranges[0]
    expect(hit.lines[0].text.slice(s, e)).toBe('needle')
  })

  it('search reads only notes that changed since the last search, and sees edits and deletions', async () => {
    await notes.search('work', 'warm up')
    const reads = vi.spyOn(fsp, 'readFile')
    try {
      expect(await notes.search('work', 'needle')).toEqual([])
      expect(reads).not.toHaveBeenCalled()
      const file = await write('wb/work/Fresh.md', 'a needle here\n')
      expect((await notes.search('work', 'needle')).map((h) => h.path)).toEqual(['~/wb/work/Fresh.md'])
      expect(reads).toHaveBeenCalledTimes(1)
      await fsp.writeFile(file, 'a haystack\n')
      expect(await notes.search('work', 'needle')).toEqual([])
      await fsp.rm(file)
      expect(await notes.search('work', 'haystack')).toEqual([])
    } finally {
      reads.mockRestore()
    }
  })

  it('an empty query lists notes without snippets', async () => {
    const hits = await notes.search('work', '  ')
    expect(hits).toHaveLength(5)
    expect(hits.every((h) => h.lines.length === 0)).toBe(true)
  })
})

describe('images', () => {
  it('serves images in the notes folder and next to note entries', async () => {
    expect(await notes.asset('work', '~/wb/work/pic.png')).toMatchObject({ type: 'image/png' })
    expect(await notes.asset('work', '~/outside/diagram.svg')).toMatchObject({ type: 'image/svg+xml' })
  })

  it('refuses non-images and images elsewhere', async () => {
    expect(await status(notes.asset('work', '~/wb/work/Ideas.md'))).toBe(403)
    await write('elsewhere/pic.png', 'PNG')
    expect(await status(notes.asset('work', '~/elsewhere/pic.png'))).toBe(403)
  })
})

describe('watching', () => {
  it('reports a hand edit to a note that was opened', async () => {
    await notes.read('work', '~/wb/work/Ideas.md')
    const event = new Promise<{ path: string; rev: string | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no note event')), 3000)
      notes.on('note', (e) => {
        clearTimeout(t)
        resolve(e)
      })
    })
    await fsp.writeFile(path.join(home, 'wb/work/Ideas.md'), 'by hand\n')
    const e = await event
    expect(e.path).toBe('~/wb/work/Ideas.md')
    expect(e.rev).toBe((await notes.read('work', '~/wb/work/Ideas.md')).rev)
  })
})

describe('watching a folder that was replaced', () => {
  it('watches again after the folder is deleted and made anew', async () => {
    await notes.read('work', '~/wb/work/Ideas.md')
    await fsp.rm(path.join(home, 'wb/work'), { recursive: true })
    await write('wb/work/Ideas.md', 'again\n')
    await notes.read('work', '~/wb/work/Ideas.md')
    // Let events from the delete settle, so only the hand edit below can pass this test.
    await new Promise((r) => setTimeout(r, 300))
    const event = new Promise<{ path: string; rev: string | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no note event')), 3000)
      notes.on('note', (e) => {
        clearTimeout(t)
        resolve(e)
      })
    })
    await fsp.writeFile(path.join(home, 'wb/work/Ideas.md'), 'by hand\n')
    expect(await event).toEqual({ path: '~/wb/work/Ideas.md', rev: (await notes.read('work', '~/wb/work/Ideas.md')).rev })
  })
})

describe('saves are reported', () => {
  it('emits the new rev so other windows can follow', async () => {
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    const events: unknown[] = []
    notes.on('note', (e) => events.push(e))
    const saved = await notes.write('work', '~/wb/work/Ideas.md', rev, 'new')
    expect(events).toEqual([{ path: '~/wb/work/Ideas.md', rev: saved.rev }])
  })
})

describe('Markdown in the file browser’s folders', () => {
  const BROWSE = `name: Browse
sections:
  - title: Projects
    items:
      - { label: Proj, type: folder, path: ~/proj }
`
  let browseStore: Wiki
  let browse: Notes

  beforeEach(async () => {
    await fsp.writeFile(path.join(dir, 'cfg/profiles/browse.yaml'), BROWSE)
    await write('proj/docs/Guide.md', '# Guide\n')
    await write('proj/data.txt', 'data\n')
    await write('proj/pic.png', 'PNG')
    await migrateFixture(path.join(dir, 'cfg'), home)
    browseStore = new Wiki(path.join(home, 'wb'), home)
    await browseStore.init({ watch: false })
    browse = new Notes(browseStore, home)
  })

  afterEach(() => {
    browse.close()
    browseStore.close()
  })

  it('opens and saves .md anywhere in folder entries', async () => {
    const note = await browse.read('browse', '~/proj/docs/Guide.md')
    await browse.write('browse', '~/proj/docs/Guide.md', note.rev, '# Guide v2\n')
    expect(await fsp.readFile(path.join(home, 'proj/docs/Guide.md'), 'utf8')).toBe('# Guide v2\n')
  })

  it('still refuses other files there, and Markdown elsewhere', async () => {
    expect(await status(browse.read('browse', '~/proj/data.txt'))).toBe(403)
    expect(await status(browse.read('browse', '~/secret.md'))).toBe(403)
    await fsp.symlink(path.join(home, 'secret.md'), path.join(home, 'proj/out.md'))
    expect(await status(browse.read('browse', '~/proj/out.md'))).toBe(403)
  })

  it('serves images inside folder entries', async () => {
    expect(await browse.asset('browse', '~/proj/pic.png')).toMatchObject({ type: 'image/png' })
  })

  it('keeps list and search to the wiki and note entries', async () => {
    expect((await browse.list('browse')).map((n) => n.name).sort()).toEqual(['Proj', 'index'])
    // Guide.md opens as a note (above) but is not searched.
    expect(await browse.search('browse', 'guide')).toEqual([])
    expect((await browse.search('browse', 'proj')).map((h) => h.path)).toContain('~/wb/browse/pages/Proj.md')
  })
})

describe('HTTP routes', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  beforeEach(async () => {
    server = await buildServer({ dir: path.join(home, 'wb'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), gitFetchEveryMs: 0 })
  })

  afterEach(() => server.app.close())

  const get = (url: string, h: Record<string, string> = headers) => server.app.inject({ method: 'GET', url, headers: h })
  const q = (p: string) => encodeURIComponent(p)

  it('every notes route needs the X-Workbench header', async () => {
    const bare = { host: '127.0.0.1:7420' }
    for (const url of [
      `/api/notes/file?profile=work&path=${q('~/wb/work/Ideas.md')}`,
      '/api/notes/list?profile=work',
      '/api/notes/search?profile=work&q=x',
      `/api/notes/asset?profile=work&path=${q('~/wb/work/pic.png')}`,
    ]) {
      expect((await get(url, bare)).statusCode).toBe(403)
    }
    const post = await server.app.inject({
      method: 'POST',
      url: '/api/notes/file',
      headers: bare,
      payload: { profile: 'work', path: '~/wb/work/X.md', rev: null, text: 'x' },
    })
    expect(post.statusCode).toBe(403)
  })

  it('reads, saves and reports conflicts with the current rev', async () => {
    const read = await get(`/api/notes/file?profile=work&path=${q('~/wb/work/Ideas.md')}`)
    expect(read.statusCode).toBe(200)
    const { rev } = read.json()
    const save = (r: string | null, text: string) =>
      server.app.inject({ method: 'POST', url: '/api/notes/file', headers, payload: { profile: 'work', path: '~/wb/work/Ideas.md', rev: r, text } })
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

describe('frontmatter', () => {
  it('is parsed into meta; broken YAML is reported without breaking the note', async () => {
    await write('wb/work/Tuohi.md', '---\nstatus: paused\ntags: [game, art]\n---\n# Tuohi\n')
    const file = await notes.read('work', '~/wb/work/Tuohi.md')
    expect(file.meta).toEqual({ status: 'paused', tags: ['game', 'art'] })
    expect(file.metaError).toBeUndefined()
    expect(file.text.startsWith('---\nstatus')).toBe(true)
    await write('wb/work/Bad.md', '---\nstatus: [\n---\nbody\n')
    const bad = await notes.read('work', '~/wb/work/Bad.md')
    expect(bad.meta).toEqual({})
    expect(bad.metaError).toBeTruthy()
    expect((await notes.read('work', '~/wb/work/Ideas.md')).meta).toEqual({})
  })

  it('comes back with a save', async () => {
    const { rev } = await notes.read('work', '~/wb/work/Ideas.md')
    const saved = await notes.write('work', '~/wb/work/Ideas.md', rev, '---\ntags: [x]\n---\n# Ideas\n')
    expect(saved.meta).toEqual({ tags: ['x'] })
  })
})

describe('overview', () => {
  it('counts tags and lists the pages that links name but nobody wrote, spelled as the newest linker does', async () => {
    await write('wb/work/Tagged.md', '---\ntags: [deploy, game]\n---\n# Tagged\n\nSee [[Release notes]] and [[Ideas]], [[sub/Deploy plan#steps|the plan]], [[Nope.md]].\n')
    await write('wb/work/Inline.md', '# Inline\n\n#deploy again; [[release notes]] too, and [[Nope]].\n')
    const hourAgo = new Date(Date.now() - 3600_000)
    await fsp.utimes(path.join(home, 'wb/work/Tagged.md'), hourAgo, hourAgo)
    const o = await notes.overview('work')
    expect(o.tags).toEqual([
      { tag: 'deploy', count: 2 },
      { tag: 'game', count: 1 },
    ])
    expect(o.missing.map((m) => [m.name, m.count])).toEqual([
      ['release notes', 2],
      ['Nope', 2],
    ])
    expect(o.missing[0].from).toBe('~/wb/work/Inline.md')
  })
})

describe('backlinks', () => {
  it('lists notes linking here by name, path, alias, heading or relative link, with the lines', async () => {
    await write('wb/work/A.md', 'See [[Deploy plan]] and [[sub/Deploy plan|the plan]].\n\nAlso [[Deploy plan#Steps]].\n')
    await write('wb/work/sub/B.md', 'Relative: [plan](Deploy%20plan.md) and [[Ideas]].\n')
    await write('wb/work/C.md', 'Nothing here. [[Other]]\n')
    const hits = await notes.backlinks('work', '~/wb/work/sub/Deploy plan.md')
    expect(hits.map((h) => h.path).sort()).toEqual(['~/wb/work/A.md', '~/wb/work/sub/B.md'])
    const a = hits.find((h) => h.path === '~/wb/work/A.md')!
    expect(a.lines.map((l) => l.line)).toEqual([1, 3])
    expect(a.lines[0].ranges).toEqual([
      [4, 19],
      [24, 52],
    ])
    expect(a.lines[0].text).toBe('See [[Deploy plan]] and [[sub/Deploy plan|the plan]].')
    expect(hits.find((h) => h.path === '~/wb/work/sub/B.md')!.lines[0].ranges).toEqual([[10, 34]])
  })

  it('does not list the note itself, and reaches note entries outside the notes folder', async () => {
    await write('wb/work/sub/Deploy plan.md', '# Deploy plan\n\n[[Deploy plan]] myself.\n[[RUNBOOK]]\n')
    expect(await notes.backlinks('work', '~/wb/work/sub/Deploy plan.md')).toEqual([])
    // index.md links the Runbook entry too.
    expect((await notes.backlinks('work', '~/outside/RUNBOOK.md')).map((h) => h.path).sort()).toEqual(['~/wb/work/index.md', '~/wb/work/sub/Deploy plan.md'])
  })
})

describe('rename', () => {
  const read = (rel: string) => fsp.readFile(path.join(home, rel), 'utf8')

  it('renames the file and rewrites links to it in every form', async () => {
    await write('wb/work/A.md', 'See [[Deploy plan]], [[sub/Deploy plan|the plan]] and [[Deploy plan#Steps]].\n')
    await write('wb/work/sub/B.md', 'Relative: [plan](Deploy%20plan.md#steps) and [[Ideas]].\n')
    await write('wb/work/sub/Deploy plan.md', '# Deploy plan\n\nSee [[Deploy plan]] (myself) and [[Ideas]].\n')
    const res = await notes.rename('work', '~/wb/work/sub/Deploy plan.md', 'Release plan')
    expect(res).toEqual({ path: '~/wb/work/sub/Release plan.md', files: 3, links: 5 })
    expect(fs.existsSync(path.join(home, 'wb/work/sub/Deploy plan.md'))).toBe(false)
    expect(await read('wb/work/A.md')).toBe('See [[Release plan]], [[sub/Release plan|the plan]] and [[Release plan#Steps]].\n')
    expect(await read('wb/work/sub/B.md')).toBe('Relative: [plan](Release%20plan.md#steps) and [[Ideas]].\n')
    expect(await read('wb/work/sub/Release plan.md')).toBe('# Deploy plan\n\nSee [[Release plan]] (myself) and [[Ideas]].\n')
    // The list follows.
    expect((await notes.list('work')).map((n) => n.name)).toContain('Release plan')
  })

  it('leaves links that point elsewhere alone, including another note with the same name', async () => {
    await write('wb/work/Deploy plan.md', 'top-level plan\n')
    await write('wb/work/A.md', '[[Deploy plan]] is the top-level one; [[sub/Deploy plan]] is the other.\n')
    await notes.rename('work', '~/wb/work/sub/Deploy plan.md', 'Release plan')
    expect(await read('wb/work/A.md')).toBe('[[Deploy plan]] is the top-level one; [[sub/Release plan]] is the other.\n')
  })

  it('refuses a taken name, a bad name and notes outside the notes folder; the same name is a no-op', async () => {
    await write('wb/work/sub/Taken.md', 'x\n')
    expect(await status(notes.rename('work', '~/wb/work/sub/Deploy plan.md', 'Taken'))).toBe(409)
    expect(await status(notes.rename('work', '~/wb/work/sub/Deploy plan.md', '...'))).toBe(400)
    expect(await status(notes.rename('work', '~/outside/RUNBOOK.md', 'Other'))).toBe(422)
    expect(await notes.rename('work', '~/wb/work/sub/Deploy plan.md', 'Deploy plan.md')).toEqual({ path: '~/wb/work/sub/Deploy plan.md', files: 0, links: 0 })
    expect(fs.existsSync(path.join(home, 'wb/work/sub/Deploy plan.md'))).toBe(true)
  })

  it('tells open views, keeps the mode of rewritten notes, and skips a note edited meanwhile', async () => {
    const a = await write('wb/work/A.md', '[[Deploy plan]]\n')
    await fsp.chmod(a, 0o600)
    await notes.read('work', '~/wb/work/A.md')
    await notes.read('work', '~/wb/work/sub/Deploy plan.md')
    const events: { path: string; rev: string | null }[] = []
    notes.on('note', (e) => events.push(e))
    const res = await notes.rename('work', '~/wb/work/sub/Deploy plan.md', 'Release plan')
    expect(res.files).toBe(1)
    expect((await fsp.stat(a)).mode & 0o777).toBe(0o600)
    expect(events).toContainEqual({ path: '~/wb/work/sub/Deploy plan.md', rev: null })
    expect(events.find((e) => e.path === '~/wb/work/A.md')?.rev).toBeTruthy()
  })
})

describe('templates', () => {
  it('returns the template when there is one, and refuses odd names', async () => {
    expect(await notes.template('work', 'page')).toEqual({ text: null })
    await write('wb/work/templates/page.md', '# {{title}}\n\n{{date}}\n')
    expect(await notes.template('work', 'page')).toEqual({ text: '# {{title}}\n\n{{date}}\n' })
    expect(await status(notes.template('work', '../Ideas'))).toBe(400)
    expect(await notes.template('bare', 'page')).toEqual({ text: null })
  })
})

describe('HTTP routes for the wiki', () => {
  let server: Awaited<ReturnType<typeof buildServer>>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  beforeEach(async () => {
    server = await buildServer({ dir: path.join(home, 'wb'), port: 7420, distDir: null, home, watch: false, stateDir: path.join(dir, 'state'), gitFetchEveryMs: 0 })
    await write('wb/work/A.md', 'See [[Deploy plan]].\n')
  })

  afterEach(() => server.app.close())

  const q = (p: string) => encodeURIComponent(p)

  it('need the X-Workbench header', async () => {
    const bare = { host: '127.0.0.1:7420' }
    expect((await server.app.inject({ method: 'GET', url: `/api/notes/backlinks?profile=work&path=${q('~/wb/work/sub/Deploy plan.md')}`, headers: bare })).statusCode).toBe(403)
    expect((await server.app.inject({ method: 'GET', url: '/api/notes/template?profile=work&name=page', headers: bare })).statusCode).toBe(403)
    expect((await server.app.inject({ method: 'POST', url: '/api/notes/rename', headers: bare, payload: { profile: 'work', path: '~/wb/work/A.md', name: 'B' } })).statusCode).toBe(403)
  })

  it('serve backlinks and templates, and rename with the links', async () => {
    const back = await server.app.inject({ method: 'GET', url: `/api/notes/backlinks?profile=work&path=${q('~/wb/work/sub/Deploy plan.md')}`, headers })
    expect(back.json().map((h: { path: string }) => h.path)).toEqual(['~/wb/work/A.md'])
    expect((await server.app.inject({ method: 'GET', url: '/api/notes/template?profile=work&name=page', headers })).json()).toEqual({ text: null })
    const renamed = await server.app.inject({ method: 'POST', url: '/api/notes/rename', headers, payload: { profile: 'work', path: '~/wb/work/sub/Deploy plan.md', name: 'Release plan' } })
    expect(renamed.json()).toEqual({ path: '~/wb/work/sub/Release plan.md', files: 1, links: 1 })
    expect(await fsp.readFile(path.join(home, 'wb/work/A.md'), 'utf8')).toBe('See [[Release plan]].\n')
    expect((await server.app.inject({ method: 'POST', url: '/api/notes/rename', headers, payload: { profile: 'work', path: '~/outside/RUNBOOK.md', name: 'X' } })).statusCode).toBe(422)
  })

  it('renaming a wiki page in the file browser rewrites links too; other renames are plain', async () => {
    const op = (p: string, name: string) => server.app.inject({ method: 'POST', url: '/api/files/op', headers, payload: { profile: 'work', op: { op: 'rename', path: p, name } } })
    const res = await op('~/wb/work/sub/Deploy plan.md', 'Release plan.md')
    expect(res.json()).toEqual({ path: '~/wb/work/sub/Release plan.md' })
    expect(await fsp.readFile(path.join(home, 'wb/work/A.md'), 'utf8')).toBe('See [[Release plan]].\n')
    // To another extension it is no longer a page: a plain rename, links untouched.
    expect((await op('~/wb/work/sub/Release plan.md', 'plan.txt')).json()).toEqual({ path: '~/wb/work/sub/plan.txt' })
    expect(await fsp.readFile(path.join(home, 'wb/work/A.md'), 'utf8')).toBe('See [[Release plan]].\n')
  })
})
