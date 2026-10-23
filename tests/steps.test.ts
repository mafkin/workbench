import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps, OpError } from '../server/config-ops.ts'
import { buildServer } from '../server/main.ts'
import { categoryColor, chatName, entrySlot, folderRoots, itemBase, NavItem, Profile, projectHost, projectRef, stepEntry, stepPath, stepSlot, stepsOf, type Op } from '../shared/config-schema.ts'

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

  it('an older project without steps: shows All files, Git in a repository, Claude setup and the workflow', () => {
    expect(labels(profile, 0)).toEqual(['All files', 'Claude setup', 'assets', 'modeling'])
    expect(stepsOf(profile, profile.sections[0].items[0], true).map((s) => s.type)).toEqual(['files', 'git', 'setup', 'folder', 'launch'])
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

describe('chat steps and entries', () => {
  it('a chat step runs claude in the project unless it names an agent or a folder', () => {
    const { profile } = run([
      { op: 'addStep', at: wargame, step: { label: 'agent', type: 'chat' } },
      { op: 'addStep', at: wargame, step: { label: 'shell', type: 'chat', agent: 'shell', path: 'src', args: ['--norc'] } },
    ])
    const [, agent, shell] = stepsOf(profile, profile.sections[0].items[1])
    expect(stepEntry('~/wargame', agent)).toEqual({ label: 'agent', type: 'chat', args: [], path: '~/wargame' })
    expect(stepEntry('~/wargame', shell)).toMatchObject({ agent: 'shell', path: '~/wargame/src', args: ['--norc'] })
  })

  it('a chat can be a nav entry, inside a group too; its agent is claude, shell or an agent profile', () => {
    expect(NavItem.parse({ label: 'Scratch', type: 'chat', path: '~' })).toEqual({ label: 'Scratch', type: 'chat', path: '~', args: [] })
    expect(NavItem.safeParse({ label: 'X', type: 'group', items: [{ label: 'c', type: 'chat' }] }).success).toBe(true)
    // A name that is no agent profile is refused when the chat starts (agents-http.test.ts).
    expect(NavItem.safeParse({ label: 'X', type: 'chat', agent: 'Reviewer' }).success).toBe(true)
    expect(NavItem.safeParse({ label: 'X', type: 'chat', agent: '' }).success).toBe(false)
  })

  it('keys chats by path and label, not by place in the nav', () => {
    expect(projectHost('~/alpha/')).toBe('project:~/alpha')
    expect(stepSlot('~/alpha', 'agent')).toBe('step:~/alpha|agent')
    expect(entrySlot({ label: 'Scratch' })).toBe('entry:~|Scratch')
  })

  it("names a chat by your name, else the program's title without its spinner, else the agent", () => {
    expect(chatName({ label: 'parser', title: '✳ Fix tests', agent: 'claude' })).toBe('parser')
    expect(chatName({ label: null, title: '⠂ Fix tests', agent: 'claude' })).toBe('Fix tests')
    expect(chatName({ label: null, title: null, agent: 'shell' })).toBe('Shell')
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
  it('writes the tabs an older project showed on its first change, keeping comments', () => {
    const { text, profile } = run([{ op: 'addStep', at: tuohi, step: { label: 'design', type: 'note', path: 'docs/design.md' } }])
    expect(labels(profile, 0)).toEqual(['All files', 'Claude setup', 'assets', 'modeling', 'design'])
    expect(profile.workflow.map((s) => s.label)).toEqual(['assets', 'modeling'])
    expect(text.match(/# textures and sprites/g)).toHaveLength(2)
    expect(text).toContain('# Every project starts with these')
  })

  it('uses the seed the service gives (Git in a repository) for that first change', () => {
    const seed = stepsOf(Profile.parse(parseDocument(SOURCE).toJS()), { label: 'x', type: 'folder', path: '~/x' }, true)
    const { profile } = run([{ op: 'deleteStep', at: tuohi, index: 2, seed }])
    expect(labels(profile, 0)).toEqual(['All files', 'Git', 'assets', 'modeling'])
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
    expect(labels(run([{ op: 'deleteStep', at: wargame, index: 0 }]).profile, 1)).toEqual([])
    const two = run([{ op: 'addStep', at: wargame, step: { label: 'Git', type: 'git' } }]).text
    expect(labels(run([{ op: 'moveStep', at: wargame, from: 1, to: 0 }], two).profile, 1)).toEqual(['Git', 'rules'])
  })

  it('adds the profile steps an item does not have yet', () => {
    const { profile } = run([{ op: 'addWorkflow', at: wargame }])
    expect(labels(profile, 1)).toEqual(['rules', 'assets', 'modeling'])
    const again = run([{ op: 'addWorkflow', at: wargame }, { op: 'addWorkflow', at: wargame }])
    expect(labels(again.profile, 1)).toEqual(['rules', 'assets', 'modeling'])
  })

  it("makes an item's steps the profile workflow; the item keeps its own", () => {
    const { text, profile } = run([{ op: 'setWorkflow', at: wargame }])
    expect(profile.workflow.map((s) => s.label)).toEqual(['rules'])
    expect(labels(profile, 0)).toEqual(['All files', 'Claude setup', 'rules'])
    expect(labels(profile, 1)).toEqual(['rules'])
    expect(text).toContain('# my own')
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
    expect(labels(run([{ op: 'addStep', at: tuohi, step: { label: 'a', type: 'folder', path: 'a' } }], source).profile, 0)).toEqual(['All files', 'Claude setup', 'a'])
  })

  it('refuses steps on other entries and other step types', () => {
    expect(() => run([{ op: 'addStep', at: { section: 0, index: 2 }, step: { label: 'a', type: 'folder', path: 'a' } }])).toThrow(OpError)
    expect(() => run([{ op: 'addStep', at: tuohi, step: { label: 'a', type: 'daily' } }])).toThrow(/A step is a file browser, folder, note, Git/)
    expect(() => run([{ op: 'deleteStep', at: tuohi, index: 5 }])).toThrow(/Step 5 does not exist/)
  })

  it('keeps steps when the entry itself is edited', () => {
    const { profile } = run([{ op: 'updateItem', at: wargame, item: { label: 'War game', type: 'folder', path: '~/wargame' } }])
    expect(labels(profile, 1)).toEqual(['rules'])
  })
})

describe('blank items', () => {
  const blank = { section: 0, index: 3 }
  const withItem = (text = SOURCE) => run([{ op: 'addItem', to: { section: 0 }, item: { label: 'Ideas', type: 'item' } }], text)

  it('a new item is written as type: item with no steps, and an id when it has no folder', () => {
    const { text, profile } = withItem()
    const item = profile.sections[0].items[3]
    expect(item).toMatchObject({ label: 'Ideas', type: 'folder', steps: [] })
    expect(item.type === 'folder' && item.path).toBeUndefined()
    expect(item.id).toMatch(/^i[0-9a-f]{7}$/)
    expect(text).toMatch(/- label: Ideas\n\s+type: item\n\s+id: i[0-9a-f]{7}\n\s+steps: \[\]/)
    expect(projectRef(item as { label: string })).toBe(`id:${item.id}`)
    expect(itemBase(profile, item as { path?: string })).toBe('~')
    // No folder: not a browse root; chats and keys still work.
    expect(folderRoots(profile).map((r) => r.label)).not.toContain('Ideas')
    expect(projectHost(projectRef(item as { label: string }))).toBe(`project:id:${item.id}`)
  })

  it('a new item with a folder has no id; type: folder and type: item read alike', () => {
    const { profile } = run([{ op: 'addItem', to: { section: 0 }, item: { label: 'Game', type: 'item', path: '~/game' } }])
    expect(profile.sections[0].items[3]).toEqual({ label: 'Game', type: 'folder', path: '~/game', steps: [] })
    expect(NavItem.parse({ label: 'A', type: 'item' })).toEqual({ label: 'A', type: 'folder' })
  })

  it('a note step needs no folder; a file browser, Git or Claude setup step gives the item its folder', () => {
    const { text } = withItem()
    const noted = run([{ op: 'addStep', at: blank, step: { label: 'ideas', type: 'note', path: '~/notes/ideas.md' } }], text)
    expect(labels(noted.profile, 3)).toEqual(['ideas'])
    expect(() => run([{ op: 'addStep', at: blank, step: { label: 'Git', type: 'git' } }], noted.text)).toThrow(/no folder yet/)
    const git = run([{ op: 'addStep', at: blank, step: { label: 'Git', type: 'git' }, folder: '~/ideas' }], noted.text)
    expect(git.profile.sections[0].items[3]).toMatchObject({ path: '~/ideas' })
    expect(git.text).toMatch(/type: item\n\s+path: ~\/ideas\n/)
    expect(labels(git.profile, 3)).toEqual(['ideas', 'Git'])
  })

  it('removing every step leaves a blank item, not the profile steps', () => {
    const { text } = withItem()
    const one = run([{ op: 'addStep', at: blank, step: { label: 'n', type: 'note', path: '~/n.md' } }], text)
    expect(labels(run([{ op: 'deleteStep', at: blank, index: 0 }], one.text).profile, 3)).toEqual([])
  })

  it('editing an item keeps the word its line has', () => {
    const { text } = withItem()
    expect(run([{ op: 'updateItem', at: blank, item: { label: 'Ideas 2', type: 'folder' } }], text).text).toContain('type: item')
    expect(run([{ op: 'updateItem', at: tuohi, item: { label: 'Tuohi', type: 'folder', path: '~/Projects/tuohi' } }]).text).toMatch(/label: Tuohi\n\s+type: folder/)
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
      - { label: Loose, type: item, id: abc12345, steps: [{ label: build, type: launch, command: make }] }
`,
    )
    spawned = []
    server = await buildServer({ configDir: path.join(dir, 'cfg'), port: 7420, distDir: null, home, spawn, watch: false })
  })

  afterEach(async () => {
    await server.app.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  const open = async (step?: number, index = 0) => {
    const rev = (await server.app.inject({ method: 'GET', url: '/api/state', headers })).json().profiles[0].rev
    return server.app.inject({ method: 'POST', url: '/api/open', headers, payload: { profile: 'work', rev, at: { section: 0, index }, step } })
  }

  // Proj has no steps: of its own: All files and Claude setup (no repository) come before the workflow.
  it('opens a link step in the browser, by address', async () => {
    expect((await open(5)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'xdg-open', args: ['https://example.com/board'], cwd: undefined }])
  })

  it('does not open report or file steps outside the app', async () => {
    expect((await open(6)).statusCode).toBe(422)
  })

  it('starts a launcher step in the project folder, by address', async () => {
    expect((await open(4)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'blender', args: ['models/main.blend'], cwd: path.join(home, 'proj') }])
  })

  it('an item without a folder runs its launchers in home, and has nothing to open in Files', async () => {
    expect((await open(0, 1)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'make', args: [], cwd: home }])
    expect((await open(undefined, 1)).statusCode).toBe(422)
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
