import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { buildServer } from '../server/main.ts'
import { categoryColor, chatName, entrySlot, folderRoots, NavItem, Profile, projectHost, stepEntry, stepPath, stepSlot, stepsOf } from '../shared/config-schema.ts'

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

const labels = (profile: Profile, index: number) => stepsOf(profile, profile.sections[0].items[index]).map((s) => s.label)

describe('steps in the schema', () => {
  const profile = Profile.parse(parseDocument(SOURCE).toJS())

  it('an older project without steps: shows All files and the workflow (Git and Claude setup are the rail’s)', () => {
    expect(labels(profile, 0)).toEqual(['All files', 'assets', 'modeling'])
    expect(stepsOf(profile, profile.sections[0].items[0]).map((s) => s.type)).toEqual(['files', 'folder', 'launch'])
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

})

describe('chat steps and entries', () => {
  it('a chat step runs claude in the project unless it names an agent or a folder', () => {
    const steps = [
      { label: 'rules', type: 'note', path: 'docs/rules.md' },
      { label: 'agent', type: 'chat' },
      { label: 'shell', type: 'chat', agent: 'shell', path: 'src', args: ['--norc'] },
    ]
    const profile = Profile.parse({ name: 'W', sections: [{ title: 'P', items: [{ label: 'Wargame', type: 'folder', path: '~/wargame', steps }] }] })
    const [, agent, shell] = stepsOf(profile, profile.sections[0].items[0])
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

  // Proj has no steps: of its own: All files comes before the workflow.
  it('opens a link step in the browser, by address', async () => {
    expect((await open(4)).statusCode).toBe(200)
    expect(spawned).toEqual([{ command: 'xdg-open', args: ['https://example.com/board'], cwd: undefined }])
  })

  it('does not open report or file steps outside the app', async () => {
    expect((await open(5)).statusCode).toBe(422)
  })

  it('starts a launcher step in the project folder, by address', async () => {
    expect((await open(3)).statusCode).toBe(200)
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
