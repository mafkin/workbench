import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps, OpError } from '../server/config-ops.ts'
import { buildServer } from '../server/main.ts'
import { categoryColor, folderRoots, Profile, stepEntry, stepPath, stepsOf, type Op } from '../shared/config-schema.ts'

const SOURCE = `# Personal
name: Personal
home: "~"
# Every project starts with these
workflow:
  - { label: assets, type: folder, path: assets } # textures and sprites
  - { label: modeling, type: launch, command: blender, args: [models/main.blend] }
sections:
  - title: Games
    items:
      - label: Tuohi
        type: folder
        path: ~/Projects/tuohi
      - label: Wargame
        type: folder
        path: ~/wargame
        steps:
          # my own
          - { label: rules, type: note, path: docs/rules.md }
      - { label: Site, type: link, url: "https://example.com" }
`

function run(ops: Op[], source = SOURCE) {
  const doc = parseDocument(source)
  applyOps(doc, ops)
  const text = doc.toString()
  return { text, profile: Profile.parse(doc.toJS()) }
}

const tuohi = { section: 0, index: 0 }
const wargame = { section: 0, index: 1 }
const labels = (profile: Profile, index: number) => stepsOf(profile, profile.sections[0].items[index]).map((s) => s.label)

describe('steps in the schema', () => {
  const profile = Profile.parse(parseDocument(SOURCE).toJS())

  it('uses the profile workflow unless the project has its own steps', () => {
    expect(labels(profile, 0)).toEqual(['assets', 'modeling'])
    expect(labels(profile, 1)).toEqual(['rules'])
    expect(labels(profile, 2)).toEqual([])
  })

  it('reads an empty steps: as no steps, not the default', () => {
    const p = Profile.parse(parseDocument(SOURCE.replace('        steps:\n          # my own\n          - { label: rules, type: note, path: docs/rules.md }\n', '        steps:\n')).toJS())
    expect(labels(p, 1)).toEqual([])
  })

  it('refuses entry types that are not steps', () => {
    const bad = SOURCE.replace('type: note, path: docs/rules.md', 'type: daily')
    expect(Profile.safeParse(parseDocument(bad).toJS()).success).toBe(false)
  })

  it('resolves step paths inside the project, keeping ~ and absolute paths', () => {
    expect(stepPath('~/p', 'assets')).toBe('~/p/assets')
    expect(stepPath('~/p/', './docs/a.md')).toBe('~/p/docs/a.md')
    expect(stepPath('~/p', '../shared')).toBe('~/shared')
    expect(stepPath('~/p', '~/Assets')).toBe('~/Assets')
    expect(stepPath('~/p', '/srv/x')).toBe('/srv/x')
    expect(stepPath('~/p', '.')).toBe('~/p')
  })

  it('turns a step into an entry: launchers run in the project by default', () => {
    expect(stepEntry('~/p', { label: 'm', type: 'launch', command: 'blender', args: ['a.blend'] })).toMatchObject({ cwd: '~/p' })
    expect(stepEntry('~/p', { label: 'm', type: 'launch', command: 'make', args: [], cwd: 'build' })).toMatchObject({ cwd: '~/p/build' })
    expect(stepEntry('~/p', { label: 'a', type: 'folder', path: 'assets' })).toMatchObject({ type: 'folder', path: '~/p/assets' })
  })

  it('lets the browser open folder steps, also outside the project', () => {
    const p = Profile.parse(parseDocument(SOURCE.replace('path: assets }', 'path: ~/Shared/assets }')).toJS())
    expect(folderRoots(p).map((r) => r.path)).toEqual(['~', '~/Projects/tuohi', '~/Shared/assets', '~/wargame'])
  })
})

describe('report, file and link steps', () => {
  const withSteps = SOURCE.replace(
    '          - { label: rules, type: note, path: docs/rules.md }\n',
    `          - { label: rules, type: note, path: docs/rules.md }
          - { label: report, type: report, path: out/report/index.html }
          - { label: render, type: file, path: ~/Renders/latest.png }
          - { label: board, type: link, url: "https://example.com/board" }
`,
  )

  it('are valid steps', () => {
    const p = Profile.parse(parseDocument(withSteps).toJS())
    expect(labels(p, 1)).toEqual(['rules', 'report', 'render', 'board'])
  })

  it("make their folders browsable, inside the project or not", () => {
    const p = Profile.parse(parseDocument(withSteps).toJS())
    const roots = folderRoots(p).map((r) => r.path)
    expect(roots).toContain('~/wargame/out/report')
    expect(roots).toContain('~/Renders')
  })

  it('a link step opens as a link entry', () => {
    expect(stepEntry('~/p', { label: 'b', type: 'link', url: 'https://example.com' })).toEqual({ label: 'b', type: 'link', url: 'https://example.com' })
  })

  it('can be added through the step ops', () => {
    const { profile } = run([{ op: 'addStep', at: wargame, step: { label: 'report', type: 'report', path: 'out/index.html' } }])
    expect(labels(profile, 1)).toEqual(['rules', 'report'])
  })
})

describe('category colours', () => {
  it('uses the profile colour, or a steady one from the palette', () => {
    const p = Profile.parse({ name: 'P', categories: { game: '#123456' }, sections: [] })
    expect(categoryColor(p, 'game')).toBe('#123456')
    expect(categoryColor(p, 'client')).toMatch(/^#[0-9a-f]{6}$/)
    expect(categoryColor(p, 'client')).toBe(categoryColor(p, 'client'))
  })

  it('refuses a colour that is not #rrggbb', () => {
    expect(Profile.safeParse({ name: 'P', categories: { game: 'green' }, sections: [] }).success).toBe(false)
  })
})

describe('step ops', () => {
  it('copies the workflow into a project on its first change, keeping comments', () => {
    const { text, profile } = run([{ op: 'addStep', at: tuohi, step: { label: 'design', type: 'note', path: 'docs/design.md' } }])
    expect(labels(profile, 0)).toEqual(['assets', 'modeling', 'design'])
    expect(profile.workflow.map((s) => s.label)).toEqual(['assets', 'modeling'])
    expect(text.match(/# textures and sprites/g)).toHaveLength(2)
    expect(text).toContain('# Every project starts with these')
  })

  it('writes a new step on one line when the list is written that way', () => {
    const { text } = run([{ op: 'addStep', at: wargame, step: { label: 'art', type: 'folder', path: 'art' } }])
    expect(text).toContain('- { label: art, type: folder, path: art }')
  })

  it('adds at an index and leaves out empty fields', () => {
    const { profile } = run([{ op: 'addStep', at: wargame, index: 0, step: { label: 'build', type: 'launch', command: 'make', args: [], cwd: '' } }])
    expect(profile.sections[0].items[1]).toMatchObject({ steps: [{ label: 'build', type: 'launch', command: 'make', args: [] }, { label: 'rules' }] })
    expect((profile.sections[0].items[1] as { steps: object[] }).steps[0]).not.toHaveProperty('cwd')
  })

  it('edits a step, dropping fields of its old type', () => {
    const { text, profile } = run([{ op: 'updateStep', at: wargame, index: 0, step: { label: 'Rules', type: 'folder', path: 'rules' } }])
    expect(stepsOf(profile, profile.sections[0].items[1])).toEqual([{ label: 'Rules', type: 'folder', path: 'rules' }])
    expect(text).toContain('# my own')
  })

  it('removes and reorders steps', () => {
    expect(labels(run([{ op: 'deleteStep', at: tuohi, index: 0 }]).profile, 0)).toEqual(['modeling'])
    expect(labels(run([{ op: 'moveStep', at: tuohi, from: 1, to: 0 }]).profile, 0)).toEqual(['modeling', 'assets'])
  })

  it('resets a project to the profile workflow', () => {
    const { text, profile } = run([{ op: 'resetSteps', at: wargame }])
    expect(labels(profile, 1)).toEqual(['assets', 'modeling'])
    expect(text).not.toContain('steps:')
  })

  it("makes a project's steps the profile workflow", () => {
    const { profile } = run([{ op: 'setWorkflow', at: wargame }])
    expect(profile.workflow.map((s) => s.label)).toEqual(['rules'])
    expect(labels(profile, 0)).toEqual(['rules'])
    expect(labels(profile, 1)).toEqual(['rules'])
  })

  it('creates the workflow before sections when the profile has none', () => {
    const source = SOURCE.replace(/# Every project starts with these\nworkflow:\n(  - .*\n)+/, '')
    const { text, profile } = run([{ op: 'setWorkflow', at: wargame }], source)
    expect(profile.workflow).toHaveLength(1)
    expect(text.indexOf('workflow:')).toBeLessThan(text.indexOf('sections:'))
    expect(text.indexOf('workflow:')).toBeGreaterThan(text.indexOf('home:'))
  })

  it('works without a workflow to copy', () => {
    const source = SOURCE.replace(/# Every project starts with these\nworkflow:\n(  - .*\n)+/, '')
    expect(labels(run([{ op: 'addStep', at: tuohi, step: { label: 'a', type: 'folder', path: 'a' } }], source).profile, 0)).toEqual(['a'])
  })

  it('refuses steps on other entries and other step types', () => {
    expect(() => run([{ op: 'addStep', at: { section: 0, index: 2 }, step: { label: 'a', type: 'folder', path: 'a' } }])).toThrow(OpError)
    expect(() => run([{ op: 'addStep', at: tuohi, step: { label: 'a', type: 'daily' } }])).toThrow(/A step is a folder, note, report, file, launcher or link/)
    expect(() => run([{ op: 'deleteStep', at: tuohi, index: 5 }])).toThrow(/Step 5 does not exist/)
  })

  it('keeps steps when the entry itself is edited', () => {
    const { profile } = run([{ op: 'updateItem', at: wargame, item: { label: 'War game', type: 'folder', path: '~/wargame' } }])
    expect(labels(profile, 1)).toEqual(['rules'])
  })
})

describe('the service and steps', () => {
  let dir: string
  let home: string
  let spawned: { command: string; args: string[]; cwd?: string }[]
  let server: Awaited<ReturnType<typeof buildServer>>
  const headers = { host: '127.0.0.1:7420', 'x-workbench': '1' }

  const spawn = ((command: string, args: string[], options: { cwd?: string }) => {
    spawned.push({ command, args, cwd: options.cwd })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    setImmediate(() => child.emit('spawn'))
    return child
  }) as any

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-steps-'))
    home = path.join(dir, 'home')
    await fsp.mkdir(path.join(dir, 'cfg/profiles'), { recursive: true })
    await fsp.mkdir(path.join(home, 'proj/models'), { recursive: true })
    await fsp.mkdir(path.join(home, 'Shared/assets'), { recursive: true })
    await fsp.writeFile(path.join(home, 'Shared/assets/tex.png'), 'PNG')
    await fsp.mkdir(path.join(home, 'briefs'), { recursive: true })
    await fsp.writeFile(path.join(home, 'briefs/brief.txt'), 'the brief\n')
    await fsp.writeFile(
      path.join(dir, 'cfg/profiles/work.yaml'),
      `name: Work
workflow:
  - { label: assets, type: folder, path: ~/Shared/assets }
  - { label: brief, type: note, path: ~/briefs/brief.txt }
  - { label: modeling, type: launch, command: blender, args: [models/main.blend] }
  - { label: board, type: link, url: "https://example.com/board" }
  - { label: report, type: report, path: out/index.html }
sections:
  - title: P
    items:
      - { label: Proj, type: folder, path: ~/proj }
`,
    )
    spawned = []
    server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, spawn, watch: false })
  })

  afterEach(async () => {
    await server.app.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  const open = async (step?: number) => {
    const rev = (await server.app.inject({ method: 'GET', url: '/api/state', headers })).json().profiles[0].rev
    return server.app.inject({ method: 'POST', url: '/api/open', headers, payload: { profile: 'work', rev, at: { section: 0, index: 0 }, step } })
  }

  it('opens a link step in the browser, by address', async () => {
    expect((await open(3)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'xdg-open', args: ['https://example.com/board'], cwd: undefined }])
  })

  it('does not open report or file steps outside the app', async () => {
    expect((await open(4)).statusCode).toBe(422)
  })

  it('starts a launcher step in the project folder, by address', async () => {
    expect((await open(2)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'blender', args: ['models/main.blend'], cwd: path.join(home, 'proj') }])
  })

  it('reports a step that does not exist', async () => {
    expect((await open(9)).statusCode).toBe(404)
  })

  it('opens folder and note steps outside the project', async () => {
    const q = (p: string) => encodeURIComponent(p)
    const list = await server.app.inject({ method: 'GET', url: `/api/files/list?profile=work&path=${q('~/Shared/assets')}`, headers })
    expect(list.json().entries.map((e: { name: string }) => e.name)).toEqual(['tex.png'])
    const note = await server.app.inject({ method: 'GET', url: `/api/notes/file?profile=work&path=${q('~/briefs/brief.txt')}`, headers })
    expect(note.json().text).toBe('the brief\n')
    const other = await server.app.inject({ method: 'GET', url: `/api/notes/file?profile=work&path=${q('~/briefs/other.txt')}`, headers })
    expect(other.statusCode).toBe(403)
  })
})
