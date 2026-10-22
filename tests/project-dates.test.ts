import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectDates } from '../server/project-dates.ts'

let dir: string
const at = (iso: string) => new Date(iso).getTime()

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-dates-')))
  await fsp.mkdir(path.join(dir, 'src/deep'), { recursive: true })
  await fsp.mkdir(path.join(dir, 'node_modules/x'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a')
  await fsp.writeFile(path.join(dir, 'src/b.txt'), 'b')
  await fsp.writeFile(path.join(dir, 'src/deep/c.txt'), 'c')
  await fsp.writeFile(path.join(dir, 'node_modules/x/new.js'), 'x')
  const set = (rel: string, iso: string) => fsp.utimes(path.join(dir, rel), new Date(iso), new Date(iso))
  await set('a.txt', '2026-01-02T00:00:00Z')
  await set('src/b.txt', '2026-03-04T00:00:00Z')
  await set('src/deep/c.txt', '2026-09-09T00:00:00Z')
  await set('node_modules/x/new.js', '2026-10-01T00:00:00Z')
  for (const d of ['src/deep', 'src', 'node_modules/x', 'node_modules']) await set(d, '2026-01-01T00:00:00Z')
})

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('a project’s dates', () => {
  it('updated is the newest file two levels down, not counting node_modules', async () => {
    const d = await projectDates(dir)
    expect(d.updated).toBe(at('2026-03-04T00:00:00Z'))
    expect(d.source).toBe('files')
    expect(d.created).toBeGreaterThan(0)
  })

  it('in a git repository, updated is the last commit', async () => {
    const env = { ...process.env, GIT_AUTHOR_DATE: '2026-05-06T07:08:09Z', GIT_COMMITTER_DATE: '2026-05-06T07:08:09Z', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one'], { cwd: dir, env })
    const d = await projectDates(dir)
    expect(d).toMatchObject({ updated: at('2026-05-06T07:08:09Z'), source: 'git' })
  })

  it('a missing folder has no dates', async () => {
    expect(await projectDates(path.join(dir, 'nope'))).toEqual({ created: null, updated: null, source: 'files' })
  })
})
