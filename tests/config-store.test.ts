import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore, parseProfile, StoreError } from '../server/config-store.ts'

let dir: string
let store: ConfigStore

const PROFILE = `# my work
name: Work
accent: "#7d93ab"
sections:
  - title: Projects
    items:
      # keep me
      - label: A
        type: folder
        path: ~/a
`

async function makeStore(files: Record<string, string> | null, opts = { watch: false }) {
  if (files) {
    await fsp.mkdir(path.join(dir, 'profiles'), { recursive: true })
    for (const [name, text] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), text)
  }
  store = new ConfigStore(dir)
  await store.init(opts)
  return store
}

const changed = (s: ConfigStore) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no change event')), 2000)
    s.once('change', () => {
      clearTimeout(t)
      resolve()
    })
  })

async function expectStatus(p: Promise<unknown>, status: number) {
  const err = await p.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(StoreError)
  expect((err as StoreError).status).toBe(status)
  return err as StoreError
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-store-'))
})

afterEach(async () => {
  store?.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('first run', () => {
  it('seeds two valid profiles with work active', async () => {
    const s = await makeStore(null)
    const state = s.state()
    expect(state.activeProfile).toBe('work')
    expect(state.profiles.map((p) => p.id)).toEqual(['work', 'personal'])
    for (const p of state.profiles) {
      expect(p.error).toBeNull()
      expect(p.profile?.sections.length).toBeGreaterThan(0)
    }
    expect(state.profiles[1].profile?.home).toBe('~')
    expect(state.profiles.map((p) => p.profile?.notes)).toEqual(['~/Documents/work/notes', '~/Documents/notes'])
    const notesHeading = state.profiles[0].profile?.sections.find((sec) => sec.title === 'Notes')
    expect(notesHeading?.items).toEqual([{ label: 'Today', type: 'daily' }])
  })

  it('does not seed over existing profiles', async () => {
    const s = await makeStore({ 'profiles/mine.yaml': PROFILE })
    expect(s.state().profiles.map((p) => p.id)).toEqual(['mine'])
  })
})

describe('errors', () => {
  it('reports the line of a YAML syntax error', () => {
    const { error } = parseProfile('name: Work\nsections:\n  - title: A\n    items: [\n')
    expect(error?.line).toBeGreaterThan(0)
  })

  it('reports the line of the item that fails validation', () => {
    const { error } = parseProfile(PROFILE.replace('        path: ~/a\n', ''))
    expect(error?.message).toMatch(/sections\[0\]\.items\[0\]/)
    expect(error?.line).toBe(8)
  })

  it('keeps the last good profile and refuses edits while the file is broken', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    const file = path.join(dir, 'profiles/work.yaml')
    const broken = PROFILE.replace('name: Work', 'name: [Work')
    await fsp.writeFile(file, broken)
    const { rev } = s.profile('work')
    const err = await expectStatus(s.apply('work', rev, [{ op: 'addSection', title: 'X' }]), 423)
    expect(err.message).toMatch(/work\.yaml has an error/)
    const p = s.profile('work')
    expect(p.error).not.toBeNull()
    expect(p.profile?.name).toBe('Work')
    expect(await fsp.readFile(file, 'utf8')).toBe(broken)
  })
})

describe('apply', () => {
  it('writes the edit, keeps comments and leaves no temp file', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    const before = s.profile('work').rev
    const { rev } = await s.apply('work', before, [{ op: 'renameSection', section: 0, title: 'Builds' }])
    expect(rev).not.toBe(before)
    const text = await fsp.readFile(path.join(dir, 'profiles/work.yaml'), 'utf8')
    expect(text).toContain('title: Builds')
    expect(text).toContain('# keep me')
    expect(text).toContain('# my work')
    expect(fs.readdirSync(path.join(dir, 'profiles'))).toEqual(['work.yaml'])
  })

  it('rejects a stale revision with 409', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    await expectStatus(s.apply('work', 'stale', [{ op: 'addSection', title: 'X' }]), 409)
  })

  it('notices a hand edit the watcher has not seen yet', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    const { rev } = s.profile('work')
    await fsp.writeFile(path.join(dir, 'profiles/work.yaml'), PROFILE.replace('Projects', 'Hand edited'))
    await expectStatus(s.apply('work', rev, [{ op: 'addSection', title: 'X' }]), 409)
    expect(s.profile('work').profile?.sections[0].title).toBe('Hand edited')
  })

  it('turns an invalid op into a 400', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    await expectStatus(s.apply('work', s.profile('work').rev, [{ op: 'deleteSection', section: 9 }]), 400)
  })

  it('serializes concurrent edits', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    const rev = s.profile('work').rev
    const results = await Promise.allSettled([
      s.apply('work', rev, [{ op: 'addSection', title: 'One' }]),
      s.apply('work', rev, [{ op: 'addSection', title: 'Two' }]),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  })
})

describe('undo', () => {
  it('restores the content from before the last edit, once', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE })
    const { rev } = await s.apply('work', s.profile('work').rev, [{ op: 'deleteSection', section: 0 }])
    const undone = await s.undo('work', rev)
    expect(await fsp.readFile(path.join(dir, 'profiles/work.yaml'), 'utf8')).toBe(PROFILE)
    await expectStatus(s.undo('work', undone.rev), 409)
  })
})

describe('settings', () => {
  it('saves the active profile and keeps comments', async () => {
    const s = await makeStore({
      'settings.yaml': '# order\nactiveProfile: work\nprofiles: [work, home]\n',
      'profiles/work.yaml': PROFILE,
      'profiles/home.yaml': PROFILE.replace('name: Work', 'name: Home'),
    })
    expect(s.state().profiles.map((p) => p.id)).toEqual(['work', 'home'])
    await s.setActive('home')
    expect(s.state().activeProfile).toBe('home')
    const text = await fsp.readFile(path.join(dir, 'settings.yaml'), 'utf8')
    expect(text).toContain('# order')
    expect(text).toContain('activeProfile: home')
    await expectStatus(s.setActive('nope'), 404)
  })
})

describe('watching', () => {
  it('picks up a hand edit and a new profile file', async () => {
    const s = await makeStore({ 'profiles/work.yaml': PROFILE }, { watch: true })
    let event = changed(s)
    await fsp.writeFile(path.join(dir, 'profiles/work.yaml'), PROFILE.replace('Projects', 'Live'))
    await event
    expect(s.profile('work').profile?.sections[0].title).toBe('Live')

    event = changed(s)
    await fsp.writeFile(path.join(dir, 'profiles/extra.yaml'), PROFILE.replace('name: Work', 'name: Extra'))
    await event
    expect(s.state().profiles.map((p) => p.id)).toContain('extra')
  })
})
