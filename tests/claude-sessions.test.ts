import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { countPrompts, sessionFile, sessionsIn, slugOf } from '../server/claude-sessions.ts'

let home: string
let project: string

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function transcript(cwd: string, id: string, lines: object[], mtime?: Date) {
  const file = path.join(home, '.claude/projects', slugOf(cwd), `${id}.jsonl`)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (mtime) await fsp.utimes(file, mtime, mtime)
  return file
}

const prompt = (cwd: string, content: unknown, extra: object = {}) => ({ type: 'user', cwd, sessionId: 'x', message: { role: 'user', content }, ...extra })

beforeEach(async () => {
  home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-sessions-')))
  project = path.join(home, 'alpha')
  await fsp.mkdir(path.join(project, 'src'), { recursive: true })
})

afterEach(async () => {
  await fsp.rm(home, { recursive: true, force: true })
})

describe('claude sessions', () => {
  test('a folder becomes the slug claude uses', () => {
    expect(slugOf('/home/u/my.project_x')).toBe('-home-u-my-project-x')
  })

  test('lists sessions in the folder and its subfolders, newest first, titled by the first real prompt', async () => {
    await transcript(project, ID(1), [{ type: 'mode' }, prompt(project, 'fix the failing test')], new Date(2026, 0, 1))
    await transcript(path.join(project, 'src'), ID(2), [prompt(path.join(project, 'src'), [{ type: 'text', text: 'tidy the parser\nand more' }])], new Date(2026, 0, 2))
    const list = await sessionsIn(project, home)
    expect(list.map((s) => [s.id, s.title, s.cwd])).toEqual([
      [ID(2), 'tidy the parser and more', '~/alpha/src'],
      [ID(1), 'fix the failing test', '~/alpha'],
    ])
  })

  test('a folder whose name only starts the same is not included', async () => {
    const other = path.join(home, 'alpha-old')
    await fsp.mkdir(other)
    await transcript(other, ID(3), [prompt(other, 'old work')])
    expect(await sessionsIn(project, home)).toEqual([])
  })

  test('skips commands, meta records and tool results for the title, and sessions without a prompt', async () => {
    await transcript(project, ID(4), [
      prompt(project, '<command-name>/model</command-name>'),
      prompt(project, 'Caveat: meta', { isMeta: true }),
      prompt(project, [{ type: 'tool_result', content: 'x' }], { toolUseResult: {} }),
      prompt(project, 'the real question'),
    ])
    await transcript(project, ID(5), [prompt(project, '<command-name>/clear</command-name>')])
    const list = await sessionsIn(project, home)
    expect(list.map((s) => s.title)).toEqual(['the real question'])
  })

  test('a name given in claude wins over the first prompt', async () => {
    await transcript(project, ID(6), [prompt(project, 'first'), { type: 'custom-title', customTitle: 'Parser rewrite', sessionId: ID(6) }])
    expect((await sessionsIn(project, home))[0].title).toBe('Parser rewrite')
  })

  test('counts your prompts in a session', async () => {
    const file = await transcript(project, ID(7), [
      prompt(project, 'one'),
      { type: 'assistant', message: { role: 'assistant', content: [] } },
      prompt(project, [{ type: 'tool_result', content: 'x' }], { toolUseResult: {} }),
      prompt(project, 'two'),
    ])
    expect(sessionFile(home, project, ID(7))).toBe(file)
    expect(await countPrompts(file)).toBe(2)
    expect(await countPrompts(path.join(home, 'missing.jsonl'))).toBe(0)
  })

  test('a transcript that cannot be read counts as none, never a rejected promise', async () => {
    // A folder in its place fails the read the way a file deleted mid-read does.
    await fsp.mkdir(path.join(home, 'odd.jsonl'))
    await expect(countPrompts(path.join(home, 'odd.jsonl'))).resolves.toBe(0)
  })
})
