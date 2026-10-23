import { describe, expect, it } from 'vitest'
import {
  addSection,
  deleteSection,
  insertItem,
  joinCommand,
  linkOf,
  moveItem,
  moveSection,
  navItemOf,
  parseChat,
  parsePage,
  parseRun,
  removeItem,
  renameSection,
  renderChat,
  renderRun,
  replaceLink,
  setMeta,
  splitCommand,
  stepOf,
  targetKind,
  type LinkContext,
  type PageRef,
} from '../server/wiki-md.ts'

const INDEX = `---
name: Work
accent: "#7d93ab"
---
Some words about this profile.

## Projects
- [[Tuohi]]
- [[projects/IFC Checker|IFC]]
- [Downloads](~/Downloads)

A note between lists.

## Reference
- [[Runbook]]
- [Docs](https://example.com "book")
- [Today](daily:)
- [Scratch](<chat:claude ~>)
- Deploy
  - [Claude here](<run:gnome-terminal --working-directory=~/x -- claude>)
  - [Nested](https://n.example)
- [Shell](<chat:shell src/>)

\`\`\`
- not an item
## not a heading
\`\`\`
`

const pages: Record<string, PageRef> = {
  tuohi: { rel: 'projects/Tuohi.md', name: 'Tuohi', meta: { folder: '~/Projects/tuohi', status: 'paused', pinned: true, icon: 'gamepad-2' }, steps: [{ type: 'files', label: 'All files' }], problems: [] },
  'projects/ifc checker': { rel: 'projects/IFC Checker.md', name: 'IFC Checker', meta: {}, steps: [], problems: [] },
  runbook: { rel: 'Runbook.md', name: 'Runbook', meta: {}, steps: [], problems: [] },
}
const ctx: LinkContext = {
  wiki: '~/notes',
  self: '~/notes/index.md',
  page: (t) => Object.values(pages).find((p) => [p.name, p.rel.replace(/\.md$/, '')].some((n) => n.toLowerCase() === t.toLowerCase())) ?? null,
  linkTo: (rel) => rel.replace(/\.md$/, '').replace(/^projects\//, ''),
}

describe('parsePage', () => {
  it('reads frontmatter, headings, items, groups and spans; fences are skipped', () => {
    const page = parsePage(INDEX)
    expect(page.meta).toEqual({ name: 'Work', accent: '#7d93ab' })
    expect(page.body).toBe(4)
    expect(page.sections.map((s) => s.title)).toEqual(['Projects', 'Reference'])
    const [projects, reference] = page.sections
    expect(projects.items.map((i) => i.link)).toEqual([
      { kind: 'wiki', target: 'Tuohi', alias: undefined, heading: undefined },
      { kind: 'wiki', target: 'projects/IFC Checker', alias: 'IFC', heading: undefined },
      { kind: 'md', label: 'Downloads', dest: '~/Downloads', title: undefined },
    ])
    expect(projects.items[0].line).toBe(7)
    expect(projects.items[0].span).toEqual([2, 11])
    expect(reference.items.map((i) => i.link.kind)).toEqual(['wiki', 'md', 'md', 'md', 'text', 'md'])
    const group = reference.items[4]
    expect(group.children.map((c) => (c.link as { label: string }).label)).toEqual(['Claude here', 'Nested'])
    expect(group.end).toBe(group.line + 3)
    expect(reference.end).toBe(27)
  })

  it('keeps a list before the first heading, or under a # title, as the lead (Workflow.md)', () => {
    const page = parsePage('- [All files](files:)\n- [design](docs/design.md)\n\n## Notes\nText.\n')
    expect(page.lead.map((i) => i.link.kind)).toEqual(['md', 'md'])
    expect(page.sections[0].items).toEqual([])
    const titled = parsePage('# Workflow\n\n- [All files](files:)\n')
    expect(titled.lead.length).toBe(1)
    expect(titled.sections).toEqual([])
  })

  it('reports broken frontmatter and still parses the body', () => {
    const page = parsePage('---\na: [\n---\n## X\n- [[Y]]\n')
    expect(page.metaError).toBeTruthy()
    expect(page.sections[0].items.length).toBe(1)
  })
})

describe('targets', () => {
  it('tells the kind from the shape', () => {
    expect(targetKind('https://x.y').kind).toBe('link')
    expect(targetKind('run:make all')).toEqual({ kind: 'run', rest: 'make all' })
    expect(targetKind('chat:')).toEqual({ kind: 'chat', rest: '' })
    expect(targetKind('daily:')).toEqual({ kind: 'daily', rest: '' })
    expect(targetKind('files:').kind).toBe('files')
    expect(targetKind('assets/sprites/')).toEqual({ kind: 'folder', rest: 'assets/sprites/' })
    expect(targetKind('src').kind).toBe('folder')
    expect(targetKind('~').kind).toBe('folder')
    expect(targetKind('docs/design.md').kind).toBe('note')
    expect(targetKind('reports/index.html').kind).toBe('report')
    expect(targetKind('renders/latest.png').kind).toBe('file')
    expect(targetKind('file:Makefile')).toEqual({ kind: 'file', rest: 'Makefile' })
    expect(targetKind('note:notes.txt')).toEqual({ kind: 'note', rest: 'notes.txt' })
    expect(targetKind('mailto:a@b.c').kind).toBe('link')
  })

  it('splits and joins command lines like a shell', () => {
    expect(splitCommand('godot --editor --path "My Game"  x')).toEqual(['godot', '--editor', '--path', 'My Game', 'x'])
    expect(splitCommand('a "b \\"c\\"" \'\'')).toEqual(['a', 'b "c"', ''])
    expect(() => splitCommand('a "b')).toThrow(/quote/)
    expect(joinCommand(['godot', '--path', 'My Game', '', 'q"t'])).toBe('godot --path "My Game" "" "q\\"t"')
    expect(splitCommand(joinCommand(['x y', 'z']))).toEqual(['x y', 'z'])
  })

  it('reads and writes run: with an optional working folder', () => {
    expect(parseRun('make all')).toEqual({ command: 'make', args: ['all'] })
    expect(parseRun('cd ~/x && gnome-terminal -- claude')).toEqual({ command: 'gnome-terminal', args: ['--', 'claude'], cwd: '~/x' })
    expect(renderRun({ command: 'make', args: ['all'] })).toBe('run:make all')
    expect(renderRun({ command: 'godot', args: ['--path', '.'], cwd: '~/g' })).toBe('run:cd ~/g && godot --path .')
    expect(() => parseRun('')).toThrow(/command/)
  })

  it('reads and writes chat: with agent, folder and args', () => {
    expect(parseChat('')).toEqual({ agent: undefined, path: undefined, args: [] })
    expect(parseChat('shell src/')).toEqual({ agent: 'shell', path: 'src', args: [] })
    expect(parseChat('src/ shell')).toEqual({ agent: 'shell', path: 'src', args: [] })
    expect(parseChat('~/')).toEqual({ agent: undefined, path: '~', args: [] })
    expect(parseChat('Reviewer -- --model opus')).toEqual({ agent: 'Reviewer', path: undefined, args: ['--model', 'opus'] })
    expect(parseChat('claude ~ --model opus')).toEqual({ agent: 'claude', path: '~', args: ['--model', 'opus'] })
    expect(parseChat('"Code Reviewer"')).toEqual({ agent: 'Code Reviewer', path: undefined, args: [] })
    expect(() => parseChat('a b')).toThrow(/two agents/)
    expect(renderChat({ agent: 'shell', path: 'src', args: [] })).toBe('chat:shell src/')
    expect(renderChat({ agent: 'shell', path: '~/x', args: [] })).toBe('chat:shell ~/x')
    expect(renderChat({ args: ['--model', 'opus'] })).toBe('chat:-- --model opus')
    expect(renderChat({ agent: 'Code Reviewer', args: [] })).toBe('chat:"Code Reviewer"')
  })
})

describe('items from links', () => {
  const items = (text: string) => parsePage(text).sections.flatMap((s) => s.items.map((i) => navItemOf(i, ctx)))

  it('turns the nav page into entries: pages are items with their card and steps', () => {
    const [tuohi, ifc, downloads] = items(INDEX).map((r) => r.item)
    expect(tuohi).toEqual({ type: 'folder', label: 'Tuohi', path: '~/Projects/tuohi', status: 'paused', pinned: true, icon: 'gamepad-2', page: 'projects/Tuohi.md', steps: [{ type: 'files', label: 'All files' }] })
    expect(ifc).toEqual({ type: 'folder', label: 'IFC', id: 'page:projects/IFC Checker.md', page: 'projects/IFC Checker.md', steps: [] })
    expect(downloads).toEqual({ type: 'folder', label: 'Downloads', path: '~/Downloads', steps: [{ type: 'files', label: 'All files' }] })
  })

  it('reads links, daily, chats, launchers and groups', () => {
    const all = items(INDEX)
    const ref = all.slice(3).map((r) => r.item)
    expect(ref[0]).toEqual({ type: 'folder', label: 'Runbook', id: 'page:Runbook.md', page: 'Runbook.md', steps: [] })
    expect(ref[1]).toEqual({ type: 'link', label: 'Docs', url: 'https://example.com', icon: 'book' })
    expect(ref[2]).toEqual({ type: 'daily', label: 'Today' })
    expect(ref[3]).toEqual({ type: 'chat', label: 'Scratch', agent: 'claude', path: '~', args: [] })
    expect(ref[4]).toEqual({
      type: 'group',
      label: 'Deploy',
      items: [
        { type: 'launch', label: 'Claude here', command: 'gnome-terminal', args: ['--working-directory=~/x', '--', 'claude'] },
        { type: 'link', label: 'Nested', url: 'https://n.example' },
      ],
    })
    expect(ref[5]).toEqual({ type: 'chat', label: 'Shell', agent: 'shell', path: 'src', args: [] })
  })

  it('a missing page is a note at the file it would be; a broken page is a note with a problem', () => {
    const [missing] = items('## X\n- [[Nope]]\n- [[Bad]]\n')
    expect(missing.item).toEqual({ type: 'note', label: 'Nope', path: '~/notes/Nope.md' })
    const broken: LinkContext = { ...ctx, page: () => ({ rel: 'Bad.md', name: 'Bad', meta: {}, metaError: 'bad yaml', steps: [], problems: [] }) }
    const r = navItemOf(parsePage('## X\n- [[Bad]]\n').sections[0].items[0], broken)
    expect(r.item).toEqual({ type: 'note', label: 'Bad', path: '~/notes/Bad.md' })
    expect(r.problem).toContain('bad yaml')
  })

  it('a step-only link or a bad command line in the nav becomes a note opening the page, with a problem', () => {
    const [files, bad, nested] = items('## X\n- [Files](files:)\n- [Run](run:"oops)\n- Group\n  - Inner\n    - [[Deep]]\n')
    expect(files.item).toEqual({ type: 'note', label: 'Files', path: '~/notes/index.md', icon: 'triangle-alert' })
    expect(files.problem).toContain('Workflow')
    expect(bad.item).toEqual({ type: 'note', label: 'Run', path: '~/notes/index.md', icon: 'triangle-alert' })
    expect(bad.problem).toMatch(/quote/)
    expect(nested.item).toEqual({ type: 'group', label: 'Group', items: [{ type: 'note', label: 'Inner', path: '~/notes/index.md', icon: 'triangle-alert' }] })
  })

  it('reads a Workflow list as steps', () => {
    const page = parsePage('## Workflow\n- [All files](files:)\n- [Git](git:)\n- [sprites](assets/sprites/)\n- [Godot](<run:godot --editor --path .>)\n- [tests](reports/index.html)\n- [render](renders/latest.png)\n- [design](docs/design.md)\n- [[Design notes]]\n- [agent](chat:)\n- [board](https://example.com/b "kanban")\n- [Today](daily:)\n- plain\n')
    const steps = page.sections[0].items.map((i) => stepOf(i, ctx))
    expect(steps.map((s) => s.step)).toEqual([
      { type: 'files', label: 'All files' },
      { type: 'git', label: 'Git' },
      { type: 'folder', label: 'sprites', path: 'assets/sprites' },
      { type: 'launch', label: 'Godot', command: 'godot', args: ['--editor', '--path', '.'] },
      { type: 'report', label: 'tests', path: 'reports/index.html' },
      { type: 'file', label: 'render', path: 'renders/latest.png' },
      { type: 'note', label: 'design', path: 'docs/design.md' },
      { type: 'note', label: 'Design notes', path: '~/notes/Design notes.md' },
      { type: 'chat', label: 'agent', agent: undefined, path: undefined, args: [] },
      { type: 'link', label: 'board', url: 'https://example.com/b', icon: 'kanban' },
      { type: 'note', label: 'Today', path: '~/notes/index.md', icon: 'triangle-alert' },
      { type: 'note', label: 'plain', path: '~/notes/index.md', icon: 'triangle-alert' },
    ])
    expect(steps[10].problem).toContain('daily')
    expect(steps[11].problem).toContain('link')
  })
})

describe('links from items', () => {
  it('writes every kind back, pages by their shortest name', () => {
    expect(linkOf({ type: 'folder', label: 'Tuohi', path: '~/t', page: 'projects/Tuohi.md', steps: [] } as never, ctx)).toBe('[[Tuohi]]')
    expect(linkOf({ type: 'folder', label: 'IFC', page: 'projects/IFC Checker.md', steps: [] } as never, ctx)).toBe('[[IFC Checker|IFC]]')
    expect(linkOf({ type: 'folder', label: 'Downloads', path: '~/Downloads', steps: [] }, ctx)).toBe('[Downloads](~/Downloads/)')
    expect(linkOf({ type: 'note', label: 'Runbook', path: '~/notes/Runbook.md' }, ctx)).toBe('[Runbook](Runbook.md)')
    expect(linkOf({ type: 'note', label: 'Runbook', path: '~/deploy/RUNBOOK.md', icon: 'book' }, ctx)).toBe('[Runbook](~/deploy/RUNBOOK.md "book")')
    expect(linkOf({ type: 'note', label: 'Plan', path: '~/outside/plan.txt' }, ctx)).toBe('[Plan](note:~/outside/plan.txt)')
    expect(linkOf({ type: 'note', label: 'Deploy', path: '~/notes/Deploy plan.md' }, ctx)).toBe('[Deploy](Deploy%20plan.md)')
    expect(linkOf({ type: 'folder', label: 'My Games', path: '~/My Games' } as never, ctx)).toBe('[My Games](~/My%20Games/)')
    expect(targetKind('Deploy%20plan.md')).toEqual({ kind: 'note', rest: 'Deploy plan.md' })
    expect(targetKind('note:a%20b.txt')).toEqual({ kind: 'note', rest: 'a b.txt' })
    expect(linkOf({ type: 'file', label: 'Make', path: 'Makefile' }, ctx)).toBe('[Make](file:Makefile)')
    expect(linkOf({ type: 'folder', label: 'Odd', path: '~/my.folder' } as never, ctx)).toBe('[Odd](~/my.folder/)')
    expect(linkOf({ type: 'link', label: 'Docs', url: 'https://example.com' }, ctx)).toBe('[Docs](https://example.com)')
    expect(linkOf({ type: 'daily', label: 'Today' }, ctx)).toBe('[Today](daily:)')
    expect(linkOf({ type: 'daily', label: 'Journal', folder: 'journal', template: 'templates/j.md' }, ctx)).toBe('[Journal](<daily:journal templates/j.md>)')
    expect(linkOf({ type: 'chat', label: 'Scratch', agent: 'claude', path: '~', args: [] }, ctx)).toBe('[Scratch](<chat:claude ~>)')
    expect(linkOf({ type: 'chat', label: 'Agent', args: [] }, ctx)).toBe('[Agent](chat:)')
    expect(linkOf({ type: 'launch', label: 'Build', command: 'make', args: ['all'] }, ctx)).toBe('[Build](<run:make all>)')
    expect(linkOf({ type: 'launch', label: 'Blender', command: 'blender', args: [] }, ctx)).toBe('[Blender](run:blender)')
    expect(linkOf({ type: 'group', label: 'Deploy', items: [] }, ctx)).toBe('Deploy')
    expect(linkOf({ type: 'files', label: 'All files' }, ctx)).toBe('[All files](files:)')
    expect(linkOf({ type: 'report', label: 'tests', path: 'reports/index.html' }, ctx)).toBe('[tests](reports/index.html)')
    expect(linkOf({ type: 'folder', label: 'sprites', path: 'assets/sprites' } as never, ctx)).toBe('[sprites](assets/sprites/)')
  })

  it('round-trips the nav page', () => {
    const page = parsePage(INDEX)
    for (const s of page.sections) {
      for (const it of s.items) {
        const { item } = navItemOf(it, ctx)
        if (!item) continue
        const written = linkOf(item, ctx)
        const again = navItemOf(parsePage(`## X\n- ${written}\n`).sections[0].items[0], ctx).item
        expect(again).toEqual(item.type === 'group' ? { ...item, items: [] } : item)
      }
    }
  })
})

describe('editing lists', () => {
  it('inserts at an index, at the end, into an empty heading and into a group; prose stays', () => {
    let text = insertItem(INDEX, 0, undefined, 1, '[[New]]')
    expect(text.split('\n').slice(6, 10)).toEqual(['## Projects', '- [[Tuohi]]', '- [[New]]', '- [[projects/IFC Checker|IFC]]'])
    text = insertItem(text, 0, undefined, undefined, '[Last](https://l)')
    expect(text).toContain('- [Downloads](~/Downloads)\n- [Last](https://l)\n\nA note between lists.')
    text = insertItem(text, 1, 4, 0, '[First](https://f)')
    expect(text).toContain('- Deploy\n  - [First](https://f)\n  - [Claude here]')
    const empty = insertItem('## Empty\n\n## Next\n- [[A]]\n', 0, undefined, 0, '[[B]]')
    expect(empty).toBe('## Empty\n\n- [[B]]\n\n## Next\n- [[A]]\n')
    const tight = insertItem('## Empty\n## Next\n', 0, undefined, 0, '[[B]]')
    expect(tight).toBe('## Empty\n\n- [[B]]\n\n## Next\n')
    const group = insertItem('## X\n- Group\n', 0, 0, 0, '[[C]]')
    expect(group).toBe('## X\n- Group\n  - [[C]]\n')
  })

  it('removes an item with its children, replaces a link keeping the rest of the line, and refuses bad addresses', () => {
    const removed = removeItem(INDEX, 1, undefined, 4)
    expect(removed).not.toContain('Deploy')
    expect(removed).not.toContain('Claude here')
    expect(removed).toContain('- [Scratch](<chat:claude ~>)\n- [Shell](<chat:shell src/>)')
    const replaced = replaceLink('## X\n- [[Old]] — the old one\n', 0, undefined, 0, '[[New|Old]]')
    expect(replaced).toBe('## X\n- [[New|Old]] — the old one\n')
    expect(() => removeItem(INDEX, 0, undefined, 9)).toThrow(/does not exist/)
    expect(() => removeItem(INDEX, 5, undefined, 0)).toThrow(/Heading 5/)
    expect(() => insertItem(INDEX, 0, 0, 0, 'x')).toThrow(/not a group/)
  })

  it('moves items between headings, into and out of groups, keeping children', () => {
    const toRef = moveItem(INDEX, { section: 0, index: 0 }, { section: 1, index: 0 })
    expect(toRef).toContain('## Projects\n- [[projects/IFC Checker|IFC]]')
    expect(toRef).toContain('## Reference\n- [[Tuohi]]\n- [[Runbook]]')
    const later = moveItem(INDEX, { section: 0, index: 0 }, { section: 0, index: 3 })
    expect(later).toContain('- [Downloads](~/Downloads)\n- [[Tuohi]]\n\nA note')
    const grouped = moveItem(INDEX, { section: 1, index: 0 }, { section: 1, group: 4, index: 1 })
    expect(grouped).toContain('- Deploy\n  - [Claude here](<run:gnome-terminal --working-directory=~/x -- claude>)\n  - [[Runbook]]\n  - [Nested]')
    const groupMoved = moveItem(INDEX, { section: 1, index: 4 }, { section: 0, index: 0 })
    expect(groupMoved).toContain('## Projects\n- Deploy\n  - [Claude here]')
    const out = moveItem(INDEX, { section: 1, group: 4, index: 1 }, { section: 0, index: 0 })
    expect(out).toContain('## Projects\n- [Nested](https://n.example)\n- [[Tuohi]]')
    expect(() => moveItem(INDEX, { section: 1, index: 4 }, { section: 1, group: 4, index: 0 })).toThrow(/group/)
  })
})

describe('editing headings', () => {
  it('adds, renames, deletes and moves headings with their blocks', () => {
    const added = addSection(INDEX, 'Tools', 1)
    expect(added).toContain('A note between lists.\n\n## Tools\n\n## Reference')
    const last = addSection('## A\n- [[x]]\n', 'B')
    expect(last).toBe('## A\n- [[x]]\n\n## B\n')
    expect(renameSection(INDEX, 0, 'Work')).toContain('## Work\n- [[Tuohi]]')
    const deleted = deleteSection(INDEX, 0)
    expect(deleted).toContain('Some words about this profile.\n\n## Reference')
    expect(deleted).not.toContain('Tuohi')
    const moved = moveSection(INDEX, 1, 0)
    expect(moved).toContain('Some words about this profile.\n\n## Reference\n- [[Runbook]]')
    expect(moved).toContain('## Projects\n- [[Tuohi]]')
    expect(moved.trim().endsWith('A note between lists.')).toBe(true)
    expect(parsePage(moved).sections.map((s) => s.title)).toEqual(['Reference', 'Projects'])
    expect(parsePage(moveSection(moved, 1, 0)).sections.map((s) => s.title)).toEqual(['Projects', 'Reference'])
  })
})

describe('frontmatter edits', () => {
  it('sets, replaces and removes keys, keeping comments; makes and drops the block', () => {
    const text = '---\n# the card\nstatus: paused   # for now\n---\n# Tuohi\n'
    const set = setMeta(text, 'pinned', true)
    // yaml normalizes the spacing before a comment, as the YAML store did.
    expect(set).toBe('---\n# the card\nstatus: paused # for now\npinned: true\n---\n# Tuohi\n')
    expect(setMeta(set, 'status', 'done')).toContain('status: done # for now')
    expect(setMeta(set, 'pinned', null)).toBe(text.replace('   #', ' #'))
    expect(setMeta('# Plain\n', 'folder', '~/x')).toBe('---\nfolder: ~/x\n---\n# Plain\n')
    expect(setMeta('---\nstatus: paused\n---\n# T\n', 'status', null)).toBe('# T\n')
    expect(setMeta('# T\n', 'servers', [{ name: 'web', port: 5173 }])).toBe('---\nservers:\n  - name: web\n    port: 5173\n---\n# T\n')
    expect(() => setMeta('---\na: [\n---\n', 'x', 1)).toThrow(/valid YAML/)
  })
})
