import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Op } from '../shared/config-schema.ts'
import { Wiki } from '../server/wiki.ts'
import { PERSONAL_WIKI, WORK_WIKI, writeSettings, writeWiki } from './fixtures/wiki.ts'

let dir: string
let home: string
let cfg: string
let wiki: Wiki

const NOTES = () => path.join(home, 'notes')
const read = (rel: string) => fsp.readFile(path.join(NOTES(), rel), 'utf8')
const exists = (rel: string) => fsp.access(path.join(NOTES(), rel)).then(() => true, () => false)

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
  } catch (err) {
    return (err as { status?: number }).status ?? -1
  }
  return 200
}

const run = (ops: Op[], id = 'work') => wiki.apply(id, wiki.profile(id).rev, ops)
const work = () => wiki.profile('work').profile!

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-wiki-'))
  home = path.join(dir, 'home')
  cfg = path.join(dir, 'cfg')
  await writeWiki(NOTES(), WORK_WIKI)
  await writeWiki(path.join(home, 'pnotes'), PERSONAL_WIKI)
  await writeSettings(cfg, { work: '~/notes', personal: '~/pnotes' })
  wiki = new Wiki(cfg, home)
  await wiki.init({ watch: false })
})

afterEach(async () => {
  wiki.close()
  await fsp.rm(dir, { recursive: true, force: true })
})

describe('reading a wiki', () => {
  it('turns index.md and the pages into the profile the app knows', () => {
    const p = work()
    expect(p.name).toBe('Work')
    expect(p.accent).toBe('#7d93ab')
    expect(p.notes).toBe('~/notes')
    expect(p.sections.map((s) => s.title)).toEqual(['Projects', 'Tools', 'Notes'])
    const [alpha, beta, gamma] = p.sections[0].items
    expect(alpha).toEqual({
      type: 'folder',
      label: 'Alpha',
      path: '~/alpha',
      page: 'projects/Alpha.md',
      steps: [
        { type: 'files', label: 'All files' },
        { type: 'folder', label: 'sources', path: 'src' },
        { type: 'note', label: 'readme', path: 'README.md' },
        { type: 'launch', label: 'build', command: 'make', args: ['all'] },
      ],
    })
    expect(beta).toEqual({ type: 'folder', label: 'Beta', path: '~/beta', status: 'paused', page: 'projects/Beta.md', steps: [] })
    expect(gamma).toEqual({ type: 'note', label: 'Gamma', path: '~/gamma.md' })
    expect(p.sections[1].items[0]).toEqual({ type: 'launch', label: 'Echo tool', command: 'echo', args: ['hello'] })
    const [today, ideas, runbook] = p.sections[2].items
    expect(today).toEqual({ type: 'daily', label: 'Today' })
    expect(ideas).toEqual({ type: 'folder', label: 'Ideas', id: 'page:Ideas.md', page: 'Ideas.md', steps: [] })
    expect(runbook).toEqual({ type: 'note', label: 'Runbook', path: '~/repo/RUNBOOK.md' })
    expect(p.workflow.map((s) => s.label)).toEqual(['sources', 'readme', 'build'])
    expect(wiki.profile('work').problems).toBeUndefined()
    expect(wiki.state().activeProfile).toBe('work')
    expect(wiki.state().profiles.map((x) => x.id)).toEqual(['work', 'personal'])
    expect(wiki.profile('work').file).toBe(path.join(NOTES(), 'index.md'))
    expect(wiki.profile('work').wiki).toBe('~/notes')
  })

  it('reads agents from agents/*.md and drawers from drawer pages', async () => {
    await writeWiki(NOTES(), {
      'agents/Reviewer.md': '---\nmodel: opus\npermission: plan\nfolders: [~/shared]\n---\nYou review code.\n',
      'index.md': '---\nname: Work\n---\n## Drawers\n\n- [[drawers/Work]]\n- [[drawers/Game dev]]\n',
      'drawers/Work.md': '## Projects\n- [[Alpha]]\n',
      'drawers/Game dev.md': '---\nlogo: abc.png\nfolder: ~/notes/drawers/game-dev\nuses: [Work]\n---\n## Games\n- [[Beta]]\n- [[Alpha]]\n',
    })
    await wiki.init({ watch: false })
    const p = work()
    expect(p.agents).toEqual({ Reviewer: { model: 'opus', permission: 'plan', folders: ['~/shared'], allowedTools: [], disallowedTools: [], instructions: 'You review code.' } })
    expect(p.drawers?.map((d) => d.name)).toEqual(['Work', 'Game dev'])
    expect(p.drawers?.[1]).toMatchObject({ logo: 'abc.png', folder: '~/notes/drawers/game-dev', uses: ['Work'] })
    expect(p.drawers?.[1].sections[0].items.map((i) => i.label)).toEqual(['Beta', 'Alpha'])
    expect(p.sections).toEqual([])
  })

  it('a missing page is a note at its file; a broken page or line is reported and still shows', async () => {
    await writeWiki(NOTES(), {
      'index.md': '---\nname: Work\n---\n## X\n- [[Nope]]\n- [[Bad]]\n- [Files](files:)\n- Loose\n\n- [[Alpha]]\n',
      'Bad.md': '---\nstatus: [\n---\n# Bad\n',
      'projects/Alpha.md': '---\nfolder: ~/alpha\n---\n## Workflow\n- [Today](daily:)\n',
    })
    await wiki.init({ watch: false })
    const items = work().sections[0].items
    expect(items[0]).toEqual({ type: 'note', label: 'Nope', path: '~/notes/Nope.md' })
    expect(items[1]).toEqual({ type: 'note', label: 'Bad', path: '~/notes/Bad.md' })
    expect(items[2]).toEqual({ type: 'note', label: 'Files', path: '~/notes/index.md', icon: 'triangle-alert' })
    expect(items[3].type).toBe('group')
    expect(items[4].type).toBe('folder')
    expect((items[4] as { steps: { icon?: string }[] }).steps[0].icon).toBe('triangle-alert')
    const problems = wiki.profile('work').problems ?? []
    expect(problems.some((p) => p.includes('Bad.md:'))).toBe(true)
    expect(problems.some((p) => p.includes('files:'))).toBe(true)
    expect(problems.some((p) => p.includes('daily'))).toBe(true)
  })

  it('a broken index.md keeps the last good profile and refuses edits', async () => {
    const before = work()
    await fsp.writeFile(path.join(NOTES(), 'index.md'), '---\nname: [\n---\n')
    expect(await status(run([{ op: 'addSection', title: 'X' }]))).toBe(423)
    expect(wiki.profile('work').error?.message).toMatch(/index\.md/)
    expect(wiki.profile('work').profile).toEqual(before)
  })
})

describe('nav ops write the nav page, touching only its lines', () => {
  it('adds, renames, moves and deletes headings', async () => {
    await run([{ op: 'addSection', title: 'Docs', index: 1 }])
    expect(await read('index.md')).toContain('- [Gamma](~/gamma.md)\n\n## Docs\n\n## Tools')
    await run([{ op: 'renameSection', section: 1, title: 'Documents' }])
    await run([{ op: 'moveSection', from: 1, to: 0 }])
    expect(work().sections.map((s) => s.title)).toEqual(['Documents', 'Projects', 'Tools', 'Notes'])
    await run([{ op: 'deleteSection', section: 0 }])
    expect(work().sections.map((s) => s.title)).toEqual(['Projects', 'Tools', 'Notes'])
    expect(await read('index.md')).toContain('Words about this profile.\n\n## Projects\n<!-- first entry comment -->\n- [[Alpha]]')
  })

  it('adds links of every kind, and items as pages in projects/', async () => {
    await run([
      { op: 'addItem', to: { section: 1 }, item: { type: 'link', label: 'Docs', url: 'https://example.com', icon: 'book' } },
      { op: 'addItem', to: { section: 1 }, item: { type: 'chat', label: 'Shell', agent: 'shell', path: '~/alpha' } },
      { op: 'addItem', to: { section: 1 }, index: 0, item: { type: 'group', label: 'Deploy' } },
      { op: 'addItem', to: { section: 1, group: 0 }, item: { type: 'launch', label: 'Term', command: 'gnome-terminal', args: ['--', 'claude'], cwd: '~/x' } },
      { op: 'addItem', to: { section: 0 }, item: { type: 'item', label: 'Delta', path: '~/delta' } },
      { op: 'addItem', to: { section: 0 }, item: { type: 'item', label: 'Loose idea' } },
      { op: 'addItem', to: { section: 0 }, item: { type: 'folder', label: 'Downloads', path: '~/Downloads' } },
    ])
    expect(await read('index.md')).toContain(
      '## Tools\n- Deploy\n  - [Term](<run:cd ~/x && gnome-terminal -- claude>)\n- [Echo tool](<run:echo hello>)\n- [Docs](https://example.com "book")\n- [Shell](<chat:shell ~/alpha>)\n',
    )
    expect(await read('index.md')).toContain('- [Gamma](~/gamma.md)\n- [[Delta]]\n- [[Loose idea]]\n- [Downloads](~/Downloads/)\n')
    expect(await read('projects/Delta.md')).toBe('---\nfolder: ~/delta\n---\n# Delta\n')
    expect(await read('projects/Loose idea.md')).toBe('# Loose idea\n')
    const items = work().sections[0].items
    expect(items[3]).toEqual({ type: 'folder', label: 'Delta', path: '~/delta', page: 'projects/Delta.md', steps: [] })
    expect(items[4]).toEqual({ type: 'folder', label: 'Loose idea', id: 'page:projects/Loose idea.md', page: 'projects/Loose idea.md', steps: [] })
    expect(items[5]).toEqual({ type: 'folder', label: 'Downloads', path: '~/Downloads', steps: [{ type: 'files', label: 'All files' }] })
    expect(work().sections[1].items[0]).toMatchObject({ type: 'group', label: 'Deploy', items: [{ type: 'launch', label: 'Term', cwd: '~/x' }] })
  })

  it('a new item’s page comes from templates/project.md when there is one, its steps under the template’s Workflow', async () => {
    await fsp.mkdir(path.join(NOTES(), 'templates'), { recursive: true })
    await fsp.writeFile(path.join(NOTES(), 'templates/project.md'), '---\ntags: [project]\n---\n# {{title}}\n\nStarted {{date}}.\n\n## Log\n')
    await run([
      { op: 'addItem', to: { section: 0 }, item: { type: 'item', label: 'Delta', path: '~/delta', steps: [{ type: 'files', label: 'All files' }, { type: 'git', label: 'Git' }] } },
      { op: 'addItem', to: { section: 0 }, item: { type: 'item', label: 'Loose idea' } },
    ])
    const today = new Date().toISOString().slice(0, 10)
    expect(await read('projects/Delta.md')).toBe(`---\ntags: [ project ]\nfolder: ~/delta\n---\n# Delta\n\nStarted ${today}.\n\n## Log\n\n## Workflow\n\n- [All files](files:)\n- [Git](git:)\n`)
    expect(await read('projects/Loose idea.md')).toBe(`---\ntags: [ project ]\n---\n# Loose idea\n\nStarted ${today}.\n\n## Log\n`)
    expect(work().sections[0].items[3]).toMatchObject({ label: 'Delta', page: 'projects/Delta.md', steps: [{ type: 'files' }, { type: 'git' }] })
    // Workflow.md is a template too, but it is copied in by Add profile steps, not here.
    expect(work().sections[0].items[4]).toMatchObject({ label: 'Loose idea', steps: [] })
  })

  it('edits a page item (alias, folder, icon), a link, and a group; a page stays a page', async () => {
    await run([{ op: 'updateItem', at: { section: 0, index: 0 }, item: { type: 'item', label: 'Alpha project', path: '~/alpha2', icon: 'rocket' } }])
    expect(await read('index.md')).toContain('- [[Alpha|Alpha project]]\n')
    expect(await read('projects/Alpha.md')).toContain('---\nfolder: ~/alpha2\nicon: rocket\n---\n# Alpha')
    expect(work().sections[0].items[0]).toMatchObject({ label: 'Alpha project', path: '~/alpha2', icon: 'rocket', page: 'projects/Alpha.md' })
    await run([{ op: 'updateItem', at: { section: 0, index: 2 }, item: { type: 'link', label: 'Gamma site', url: 'https://g.example' } }])
    expect(await read('index.md')).toContain('- [Gamma site](https://g.example)\n')
    expect(await status(run([{ op: 'updateItem', at: { section: 0, index: 0 }, item: { type: 'note', label: 'x', path: '~/x.md' } }]))).toBe(400)
  })

  it('moves and deletes entries; the page of a deleted item stays', async () => {
    await run([{ op: 'moveItem', from: { section: 0, index: 0 }, to: { section: 2 }, index: 1 }])
    expect(work().sections[2].items.map((i) => i.label)).toEqual(['Today', 'Alpha', 'Ideas', 'Runbook'])
    await run([{ op: 'deleteItem', at: { section: 2, index: 1 } }])
    expect(work().sections[2].items.map((i) => i.label)).toEqual(['Today', 'Ideas', 'Runbook'])
    expect(await exists('projects/Alpha.md')).toBe(true)
    expect(await read('index.md')).toContain('<!-- first entry comment -->\n- [[Beta]]')
  })

  it('refuses a stale rev, and reloads a hand edit before applying', async () => {
    const rev = wiki.profile('work').rev
    await run([{ op: 'addSection', title: 'X' }])
    expect(await status(wiki.apply('work', rev, [{ op: 'addSection', title: 'Y' }]))).toBe(409)
    await fsp.appendFile(path.join(NOTES(), 'index.md'), '\n## Hand\n')
    expect(await status(wiki.apply('work', wiki.profile('work').rev, [{ op: 'addSection', title: 'Z' }]))).toBe(409)
    expect(work().sections.map((s) => s.title)).toContain('Hand')
  })

  it('undo puts the files back, removing a page an op made', async () => {
    const before = await read('index.md')
    await run([{ op: 'addItem', to: { section: 0 }, item: { type: 'item', label: 'Delta', path: '~/delta' } }])
    expect(await exists('projects/Delta.md')).toBe(true)
    await wiki.undo('work', wiki.profile('work').rev)
    expect(await read('index.md')).toBe(before)
    expect(await exists('projects/Delta.md')).toBe(false)
    expect(await status(wiki.undo('work', wiki.profile('work').rev))).toBe(409)
  })
})

describe('cards and steps live on the page', () => {
  it('setCard writes the frontmatter; active and unpinned remove the key', async () => {
    const at = { section: 0, index: 0 }
    await run([
      { op: 'setCard', at, field: 'status', value: 'paused' },
      { op: 'setCard', at, field: 'pinned', value: true },
      { op: 'setCard', at, field: 'description', value: 'The first project' },
      { op: 'setCard', at, field: 'category', value: 'work' },
      { op: 'setCard', at, field: 'agent', value: 'Reviewer' },
    ])
    expect(await read('projects/Alpha.md')).toContain('---\nfolder: ~/alpha\nstatus: paused\npinned: true\ndescription: The first project\ncategory: work\nagent: Reviewer\n---\n')
    expect(work().sections[0].items[0]).toMatchObject({ status: 'paused', pinned: true, description: 'The first project', category: 'work', agent: 'Reviewer' })
    await run([
      { op: 'setCard', at, field: 'status', value: 'active' },
      { op: 'setCard', at, field: 'pinned', value: false },
      { op: 'setCard', at, field: 'description', value: '' },
    ])
    expect(await read('projects/Alpha.md')).toContain('---\nfolder: ~/alpha\ncategory: work\nagent: Reviewer\n---\n')
  })

  it('step ops edit the Workflow heading, making it when missing', async () => {
    const at = { section: 0, index: 1 }
    await run([{ op: 'addStep', at, step: { type: 'git', label: 'Git' } }])
    expect(await read('projects/Beta.md')).toBe('---\nfolder: ~/beta\nstatus: paused\n---\n# Beta\n\n## Workflow\n\n- [Git](git:)\n')
    await run([
      { op: 'addStep', at, step: { type: 'folder', label: 'assets', path: 'assets' }, index: 0 },
      { op: 'addStep', at, step: { type: 'chat', label: 'agent', agent: 'claude' } },
    ])
    await run([{ op: 'updateStep', at, index: 2, step: { type: 'chat', label: 'shell', agent: 'shell', path: 'src' } }])
    await run([{ op: 'moveStep', at, from: 2, to: 0 }])
    expect(work().sections[0].items[1]).toMatchObject({ steps: [{ type: 'chat', label: 'shell' }, { type: 'folder', label: 'assets' }, { type: 'git' }] })
    await run([{ op: 'deleteStep', at, index: 1 }])
    expect(await read('projects/Beta.md')).toContain('## Workflow\n\n- [shell](<chat:shell src/>)\n- [Git](git:)\n')
  })

  it('a folder link becomes a page in projects/ the moment it needs a card or a step', async () => {
    await run([{ op: 'addItem', to: { section: 0 }, item: { type: 'folder', label: 'Downloads', path: '~/Downloads' } }])
    await run([{ op: 'addStep', at: { section: 0, index: 3 }, step: { type: 'git', label: 'Git' } }])
    expect(await read('index.md')).toContain('- [[Downloads]]\n')
    expect(await read('projects/Downloads.md')).toBe('---\nfolder: ~/Downloads\n---\n# Downloads\n\n## Workflow\n\n- [All files](files:)\n- [Git](git:)\n')
    expect(await status(run([{ op: 'setCard', at: { section: 0, index: 2 }, field: 'pinned', value: true }]))).toBe(400)
  })

  it('Add profile steps appends what the page lacks; Save as profile steps rewrites Workflow.md’s list, keeping its prose', async () => {
    await run([{ op: 'addWorkflow', at: { section: 0, index: 0 } }])
    expect(work().sections[0].items[0]).toMatchObject({ steps: [{ label: 'All files' }, { label: 'sources' }, { label: 'readme' }, { label: 'build' }] })
    await run([{ op: 'addWorkflow', at: { section: 0, index: 1 } }])
    expect(await read('projects/Beta.md')).toContain('## Workflow\n\n- [sources](src/)\n- [readme](README.md)\n- [build](<run:make all>)\n')
    await run([{ op: 'addStep', at: { section: 0, index: 1 }, step: { type: 'git', label: 'Git' } }, { op: 'setWorkflow', at: { section: 0, index: 1 } }])
    expect(await read('Workflow.md')).toBe('# Workflow\n\nThe steps an item gets with Add profile steps.\n\n- [sources](src/)\n- [readme](README.md)\n- [build](<run:make all>)\n- [Git](git:)\n')
    expect(work().workflow.map((s) => s.label)).toEqual(['sources', 'readme', 'build', 'Git'])
  })
})

describe('the profile’s own fields', () => {
  it('setProfileField, setCategory and setMcpOff edit index.md’s frontmatter', async () => {
    await run([
      { op: 'setProfileField', key: 'theme', value: 'fjord' },
      { op: 'setProfileField', key: 'home', value: '~/work' },
      { op: 'setCategory', name: 'game', color: '#8fa58a' },
      { op: 'setMcpOff', names: ['plugin:x:slack'], off: true },
    ])
    expect(await read('index.md')).toContain('---\nname: Work\naccent: "#7d93ab"\ntheme: fjord\nhome: ~/work\ncategories:\n  game: "#8fa58a"\nmcpOff:\n  - plugin:x:slack\n---\nWords about')
    expect(work()).toMatchObject({ theme: 'fjord', home: '~/work', categories: { game: '#8fa58a' }, mcpOff: ['plugin:x:slack'] })
    await run([
      { op: 'setProfileField', key: 'theme', value: '' },
      { op: 'setCategory', name: 'game', color: null },
      { op: 'setMcpOff', names: ['plugin:x:slack'], off: false },
    ])
    expect(await read('index.md')).toContain('---\nname: Work\naccent: "#7d93ab"\nhome: ~/work\n---\n')
    expect(await status(run([{ op: 'setProfileField', key: 'notes', value: '~/elsewhere' }]))).toBe(400)
  })

  it('agent profiles are pages in agents/: create, update, rename with its uses, delete only when unused', async () => {
    await run([{ op: 'setAgent', name: 'Reviewer', agent: { model: 'opus', permission: 'plan', instructions: 'You review code.\nNo edits.', folders: ['~/shared'] } }])
    expect(await read('agents/Reviewer.md')).toBe('---\nmodel: opus\npermission: plan\nfolders:\n  - ~/shared\n---\nYou review code.\nNo edits.\n')
    expect(work().agents?.Reviewer).toMatchObject({ model: 'opus', permission: 'plan', instructions: 'You review code.\nNo edits.' })
    await run([{ op: 'setAgent', name: 'Reviewer', agent: { model: 'sonnet', instructions: 'You review code.' } }])
    expect(await read('agents/Reviewer.md')).toBe('---\nmodel: sonnet\n---\nYou review code.\n')
    await run([
      { op: 'addItem', to: { section: 1 }, item: { type: 'chat', label: 'Review', agent: 'Reviewer' } },
      { op: 'setCard', at: { section: 0, index: 0 }, field: 'agent', value: 'reviewer' },
      { op: 'addStep', at: { section: 0, index: 1 }, step: { type: 'chat', label: 'review', agent: 'Reviewer' } },
    ])
    const refused = await status(run([{ op: 'setAgent', name: 'Reviewer', agent: null }]))
    expect(refused).toBe(400)
    await run([{ op: 'setAgent', name: 'Reviewer', agent: { model: 'sonnet', instructions: 'You review code.' }, rename: 'Critic' }])
    expect(await exists('agents/Reviewer.md')).toBe(false)
    expect(await read('agents/Critic.md')).toContain('model: sonnet')
    expect(await read('index.md')).toContain('- [Review](chat:Critic)\n')
    expect(await read('projects/Alpha.md')).toContain('agent: Critic\n')
    expect(await read('projects/Beta.md')).toContain('- [review](chat:Critic)\n')
    await run([
      { op: 'deleteItem', at: { section: 1, index: 1 } },
      { op: 'setCard', at: { section: 0, index: 0 }, field: 'agent', value: null },
      { op: 'deleteStep', at: { section: 0, index: 1 }, index: 0 },
      { op: 'setAgent', name: 'Critic', agent: null },
    ])
    expect(await exists('agents/Critic.md')).toBe(false)
    expect(work().agents).toBeUndefined()
  })
})

describe('drawers are pages in drawers/', () => {
  it('the first drawer moves the nav into a page; drawers can be renamed, set and deleted; pages show in several', async () => {
    await run([{ op: 'addDrawer', name: 'Game dev' }])
    expect(await read('index.md')).toBe('---\nname: Work\naccent: "#7d93ab"\n---\n## Drawers\n\n- [[drawers/Work]]\n- [[drawers/Game dev]]\n')
    expect(await read('drawers/Work.md')).toContain('Words about this profile.\n\n## Projects\n<!-- first entry comment -->\n- [[Alpha]]')
    expect(await read('drawers/Game dev.md')).toBe('# Game dev\n')
    expect(work().drawers?.map((d) => d.name)).toEqual(['Work', 'Game dev'])
    expect(work().drawers?.[0].sections.map((s) => s.title)).toEqual(['Projects', 'Tools', 'Notes'])

    await run([{ op: 'setShared', at: { section: 0, index: 1 }, drawer: 1, on: true }])
    expect(await read('drawers/Game dev.md')).toBe('# Game dev\n\n## Projects\n\n- [[Beta]]\n')
    expect(work().drawers?.[1].sections[0].items[0]).toMatchObject({ label: 'Beta', page: 'projects/Beta.md' })
    await run([{ op: 'addSection', drawer: 1, title: 'Tools' }, { op: 'addItem', to: { drawer: 1, section: 1 }, item: { type: 'link', label: 'Godot docs', url: 'https://docs.godotengine.org' } }])
    expect(work().drawers?.[1].sections[1].items[0].label).toBe('Godot docs')
    await run([{ op: 'setShared', at: { section: 0, index: 1 }, drawer: 1, on: false }])
    expect(await read('drawers/Game dev.md')).not.toContain('Beta')

    await run([
      { op: 'setDrawer', drawer: 1, field: 'folder', value: '~/notes/drawers/game-dev' },
      { op: 'setDrawer', drawer: 1, field: 'uses', value: ['Work'] },
      { op: 'setDrawer', drawer: 0, field: 'name', value: 'Office' },
    ])
    expect(await read('index.md')).toContain('- [[drawers/Office]]\n- [[drawers/Game dev]]\n')
    expect(await exists('drawers/Work.md')).toBe(false)
    expect(await read('drawers/Game dev.md')).toContain('---\nfolder: ~/notes/drawers/game-dev\nuses:\n  - Office\n---\n')
    expect(work().drawers?.map((d) => d.name)).toEqual(['Office', 'Game dev'])
    expect(await status(run([{ op: 'moveItem', from: { section: 0, index: 0 }, to: { drawer: 1, section: 0 }, index: 0 }]))).toBe(400)
    await run([{ op: 'deleteDrawer', drawer: 1 }])
    expect(work().drawers?.map((d) => d.name)).toEqual(['Office'])
    expect(await exists('drawers/Game dev.md')).toBe(true)
    expect(await status(run([{ op: 'deleteDrawer', drawer: 0 }]))).toBe(400)
  })

  it('MCP defaults live on the drawer page: setMcpOff writes it, the first drawer op moves index.md’s key, a stray key is reported', async () => {
    await run([{ op: 'setMcpOff', names: ['plugin:x:slack'], off: true }, { op: 'addDrawer', name: 'Game dev' }])
    // The key moved with the nav into the first drawer's page.
    expect(await read('index.md')).toBe('---\nname: Work\naccent: "#7d93ab"\n---\n## Drawers\n\n- [[drawers/Work]]\n- [[drawers/Game dev]]\n')
    expect(await read('drawers/Work.md')).toMatch(/^---\nmcpOff:\n  - plugin:x:slack\n---\nWords about/)
    expect(work().mcpOff).toBeUndefined()
    expect(work().drawers?.map((d) => d.mcpOff)).toEqual([['plugin:x:slack'], undefined])
    await run([{ op: 'setMcpOff', drawer: 1, names: ['tools'], off: true }, { op: 'setMcpOff', drawer: 0, names: ['plugin:x:slack'], off: false }])
    expect(await read('drawers/Game dev.md')).toBe('---\nmcpOff:\n  - tools\n---\n# Game dev\n')
    expect(await read('drawers/Work.md')).toMatch(/^Words about/)
    expect(work().drawers?.map((d) => d.mcpOff)).toEqual([undefined, ['tools']])
    // Put back by hand on index.md: read as the first drawer's, and said so.
    await fsp.writeFile(path.join(NOTES(), 'index.md'), (await read('index.md')).replace('---\n## Drawers', 'mcpOff: [github]\n---\n## Drawers'))
    const fresh = new Wiki(cfg, home)
    await fresh.init({ watch: false })
    expect(fresh.profile('work').profile?.drawers?.[0].mcpOff).toEqual(['github'])
    expect(fresh.profile('work').problems).toContainEqual(expect.stringContaining('mcpOff'))
    fresh.close()
  })

  it('a new item in a drawer with a page gets its page under drawers/<Name>/', async () => {
    await run([{ op: 'addDrawer', name: 'Game dev' }, { op: 'addSection', drawer: 1, title: 'Chapters' }])
    await run([
      { op: 'addItem', to: { drawer: 1, section: 0 }, item: { type: 'item', label: '01 Intro screen' } },
      { op: 'addItem', to: { drawer: 0, section: 0 }, item: { type: 'item', label: 'Delta', path: '~/delta' } },
      { op: 'addItem', to: { drawer: 0, section: 0 }, item: { type: 'folder', label: 'Downloads', path: '~/Downloads' } },
    ])
    expect(await read('drawers/Game dev/01 Intro screen.md')).toBe('# 01 Intro screen\n')
    expect(await read('drawers/Game dev.md')).toBe('# Game dev\n\n## Chapters\n\n- [[01 Intro screen]]\n')
    expect(work().drawers?.[1].sections[0].items[0]).toMatchObject({ label: '01 Intro screen', page: 'drawers/Game dev/01 Intro screen.md' })
    expect(await read('drawers/Work/Delta.md')).toBe('---\nfolder: ~/delta\n---\n# Delta\n')
    // A folder link that needs a card becomes a page in the same place.
    await run([{ op: 'setCard', at: { drawer: 0, section: 0, index: 4 }, field: 'status', value: 'paused' }])
    expect(await read('drawers/Work/Downloads.md')).toContain('status: paused')
  })

  it('a drawer setting on a profile without drawers makes the first drawer page', async () => {
    await run([{ op: 'setDrawer', drawer: 0, field: 'logo', value: 'abc.png' }])
    expect(await read('drawers/Work.md')).toMatch(/^---\nlogo: abc.png\n---\nWords about this profile.\n\n## Projects\n/)
    expect(await read('index.md')).toBe('---\nname: Work\naccent: "#7d93ab"\n---\n## Drawers\n\n- [[drawers/Work]]\n')
    expect(work().drawers?.[0]).toMatchObject({ name: 'Work', logo: 'abc.png' })
  })
})

describe('profiles and settings', () => {
  it('creates a profile as a new wiki (blank or a copy), switches, and forgets one', async () => {
    await wiki.createProfile('side', { name: 'Side', wiki: '~/side' })
    expect(await fsp.readFile(path.join(home, 'side/index.md'), 'utf8')).toBe('---\nname: "Side"\naccent: "#b39b72"\n---\n## Start\n')
    expect(wiki.state().profiles.map((p) => p.id)).toEqual(['work', 'personal', 'side'])
    await wiki.createProfile('copy', { name: 'Copy', wiki: '~/copy', copyFrom: 'work' })
    expect(wiki.profile('copy').profile).toMatchObject({ name: 'Copy', accent: '#7d93ab' })
    expect(wiki.profile('copy').profile?.sections.map((s) => s.title)).toEqual(['Projects', 'Tools', 'Notes'])
    expect(await fsp.readFile(path.join(home, 'copy/Workflow.md'), 'utf8')).toBe(WORK_WIKI['Workflow.md'])
    expect(await status(wiki.createProfile('again', { name: 'Again', wiki: '~/notes' }))).toBe(409)
    expect(await status(wiki.createProfile('nested', { name: 'Nested', wiki: '~/notes/sub' }))).toBe(409)
    expect(await status(wiki.createProfile('outer', { name: 'Outer', wiki: '~' }))).toBe(409)
    expect(await status(wiki.createProfile('Bad Id', { name: 'x', wiki: '~/x' }))).toBe(400)
    await wiki.setActive('side')
    expect(wiki.state().activeProfile).toBe('side')
    await wiki.removeProfile('side')
    expect(wiki.state().profiles.map((p) => p.id)).toEqual(['work', 'personal', 'copy'])
    expect(wiki.state().activeProfile).toBe('work')
    expect(await fsp.readFile(path.join(home, 'side/index.md'), 'utf8')).toContain('Side')
    expect(await fsp.readFile(path.join(cfg, 'settings.yaml'), 'utf8')).toContain('profiles:\n  work: ~/notes\n  personal: ~/pnotes\n  copy: ~/copy\n')
  })

  it('reads YAML profiles read-only until migrate() turns them into wikis', async () => {
    const legacy = await fsp.mkdtemp(path.join(os.tmpdir(), 'workbench-legacy-'))
    const lhome = path.join(legacy, 'home')
    await fsp.mkdir(path.join(legacy, 'cfg/profiles'), { recursive: true })
    await fsp.writeFile(path.join(legacy, 'cfg/settings.yaml'), 'activeProfile: work\nprofiles: [work]\n')
    await fsp.writeFile(
      path.join(legacy, 'cfg/profiles/work.yaml'),
      'name: Work\nnotes: ~/notes\nworkflow:\n  - { label: readme, type: note, path: README.md }\nagents:\n  Reviewer: { model: opus }\nsections:\n  - title: Projects\n    items:\n      - { label: Alpha, type: folder, path: ~/alpha, status: paused }\n      - { label: Today, type: daily }\n',
    )
    const w = new Wiki(path.join(legacy, 'cfg'), lhome)
    await w.init({ watch: false })
    try {
      expect(w.legacy).toBe(true)
      expect(w.profile('work')).toMatchObject({ legacy: true })
      expect(w.profile('work').profile?.sections[0].items[0]).toMatchObject({ label: 'Alpha', status: 'paused' })
      expect(await status(w.apply('work', w.profile('work').rev, [{ op: 'addSection', title: 'X' }]))).toBe(423)
      expect(await w.migrate()).toEqual({ moved: ['work'] })
      expect(w.legacy).toBe(false)
      expect(await fsp.readFile(path.join(lhome, 'notes/index.md'), 'utf8')).toBe('---\nname: Work\naccent: "#7d93ab"\n---\n## Projects\n\n- [[Alpha]]\n- [Today](daily:)\n')
      expect(await fsp.readFile(path.join(lhome, 'notes/projects/Alpha.md'), 'utf8')).toBe('---\nfolder: ~/alpha\nstatus: paused\n---\n# Alpha\n\n## Workflow\n\n- [All files](files:)\n- [Claude setup](setup:)\n- [readme](README.md)\n')
      expect(await fsp.readFile(path.join(lhome, 'notes/agents/Reviewer.md'), 'utf8')).toBe('---\nmodel: opus\n---\n')
      expect(await fsp.readFile(path.join(legacy, 'cfg/settings.yaml'), 'utf8')).toContain('profiles:\n  work: ~/notes\n')
      await fsp.access(path.join(legacy, 'cfg/profiles/work.yaml.bak'))
      expect(w.profile('work').profile?.sections[0].items[0]).toMatchObject({ label: 'Alpha', path: '~/alpha', status: 'paused', page: 'projects/Alpha.md' })
      expect(w.profile('work').profile?.workflow.map((s) => s.label)).toEqual(['readme'])
      expect(w.profile('work').profile?.agents?.Reviewer.model).toBe('opus')
    } finally {
      w.close()
      await fsp.rm(legacy, { recursive: true, force: true })
    }
  })

  it('picks up a hand edit and a new agent page while watching', async () => {
    wiki.close()
    wiki = new Wiki(cfg, home)
    await wiki.init({ watch: true })
    const changed = new Promise<void>((resolve) => wiki.once('change', () => resolve()))
    await fsp.mkdir(path.join(NOTES(), 'agents'))
    await fsp.writeFile(path.join(NOTES(), 'agents/Helper.md'), '---\nmodel: haiku\n---\n')
    await changed
    expect(work().agents?.Helper.model).toBe('haiku')
    const again = new Promise<void>((resolve) => wiki.once('change', () => resolve()))
    await fsp.appendFile(path.join(NOTES(), 'index.md'), '\n## Hand\n- [[Alpha]]\n')
    await again
    expect(work().sections.map((s) => s.title)).toContain('Hand')
  })
})
