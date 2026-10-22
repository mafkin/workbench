import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps, OpError } from '../server/config-ops.ts'
import type { Op } from '../shared/config-schema.ts'

const SOURCE = `# Work profile
name: Work
accent: "#7d93ab"
sections:
  # Things I build
  - title: Projects
    items:
      # The checker, keep first
      - label: IFC Checker
        type: folder
        path: ~/ifc_checker_project
        owner: me # custom key the app does not manage
      - { label: Site, type: link, url: "https://example.com" }
      - label: Deploy
        type: group
        items:
          - { label: Runbook, type: note, path: ~/deploy-tools/RUNBOOK.md }
  - title: Docs
    items:
`

function run(ops: Op[], source = SOURCE) {
  const doc = parseDocument(source)
  applyOps(doc, ops)
  return { doc, text: doc.toString(), data: doc.toJS() }
}

const labels = (data: any, section: number) => data.sections[section].items.map((i: any) => i.label)

describe('sections', () => {
  it('adds a heading at the end by default', () => {
    const { data } = run([{ op: 'addSection', title: 'Tools' }])
    expect(data.sections.map((s: any) => s.title)).toEqual(['Projects', 'Docs', 'Tools'])
    expect(data.sections[2].items).toEqual([])
  })

  it('adds a heading at an index and trims the title', () => {
    const { data } = run([{ op: 'addSection', title: '  Notes ', index: 0 }])
    expect(data.sections[0].title).toBe('Notes')
  })

  it('rejects an empty heading title', () => {
    expect(() => run([{ op: 'addSection', title: '   ' }])).toThrow(OpError)
  })

  it('renames a heading and keeps its comment', () => {
    const { data, text } = run([{ op: 'renameSection', section: 0, title: 'Builds' }])
    expect(data.sections[0].title).toBe('Builds')
    expect(text).toContain('# Things I build')
  })

  it('moves a heading with arrayMove semantics and keeps its comment', () => {
    const { data, text } = run([{ op: 'moveSection', from: 0, to: 1 }])
    expect(data.sections.map((s: any) => s.title)).toEqual(['Docs', 'Projects'])
    expect(text.indexOf('# Things I build')).toBeLessThan(text.indexOf('title: Projects'))
    expect(text.indexOf('title: Docs')).toBeLessThan(text.indexOf('# Things I build'))
  })

  it('deletes a heading', () => {
    const { data } = run([{ op: 'deleteSection', section: 1 }])
    expect(data.sections).toHaveLength(1)
  })

  it('rejects an address that does not exist', () => {
    expect(() => run([{ op: 'deleteSection', section: 5 }])).toThrow(/Heading 5 does not exist/)
  })

  it('creates the sections list in an empty profile', () => {
    const { data } = run([{ op: 'addSection', title: 'First' }], 'name: Empty\n')
    expect(data.sections[0].title).toBe('First')
  })
})

describe('items', () => {
  it('adds an item to a heading whose items: is empty', () => {
    const { data } = run([
      { op: 'addItem', to: { section: 1 }, item: { label: 'Specs', type: 'folder', path: '~/Documents/work/specifications' } },
    ])
    expect(data.sections[1].items).toEqual([{ label: 'Specs', type: 'folder', path: '~/Documents/work/specifications' }])
  })

  it('omits empty optional fields on a new launcher', () => {
    const { data } = run([
      { op: 'addItem', to: { section: 1 }, item: { label: 'Blender', type: 'launch', command: 'blender', args: [], cwd: '', icon: '' } },
    ])
    expect(data.sections[1].items[0]).toEqual({ label: 'Blender', type: 'launch', command: 'blender' })
  })

  it('adds an item into a group', () => {
    const { data } = run([
      { op: 'addItem', to: { section: 0, group: 2 }, index: 0, item: { label: 'Releases', type: 'folder', path: '~/rel' } },
    ])
    expect(data.sections[0].items[2].items.map((i: any) => i.label)).toEqual(['Releases', 'Runbook'])
  })

  it('refuses a group inside a group', () => {
    expect(() =>
      run([{ op: 'addItem', to: { section: 0, group: 2 }, item: { label: 'Nested', type: 'group' } }]),
    ).toThrow(/cannot contain another group/)
  })

  it('validates the item', () => {
    expect(() => run([{ op: 'addItem', to: { section: 1 }, item: { label: 'Bad', type: 'link', url: 'not a url' } }])).toThrow(
      /url/,
    )
  })

  it('updates an item, keeping its comment and unmanaged keys', () => {
    const { data, text } = run([
      { op: 'updateItem', at: { section: 0, index: 0 }, item: { label: 'IFC Checker (dev)', type: 'folder', path: '~/ifc' } },
    ])
    expect(data.sections[0].items[0]).toEqual({ label: 'IFC Checker (dev)', type: 'folder', path: '~/ifc', owner: 'me' })
    expect(text).toContain('# The checker, keep first')
    expect(text).toContain('# custom key the app does not manage')
  })

  it('changing type drops the old type fields', () => {
    const { data } = run([
      { op: 'updateItem', at: { section: 0, index: 0 }, item: { label: 'Checker', type: 'link', url: 'https://x.test' } },
    ])
    expect(data.sections[0].items[0]).toEqual({ label: 'Checker', type: 'link', url: 'https://x.test', owner: 'me' })
  })

  it('keeps a flow-style item in flow style when edited', () => {
    const { text } = run([
      { op: 'updateItem', at: { section: 0, index: 1 }, item: { label: 'Site', type: 'link', url: 'https://example.org' } },
    ])
    expect(text).toContain('{ label: Site, type: link, url: "https://example.org" }')
  })

  it('will not turn a non-empty group into a leaf', () => {
    expect(() =>
      run([{ op: 'updateItem', at: { section: 0, index: 2 }, item: { label: 'Deploy', type: 'folder', path: '~/x' } }]),
    ).toThrow(/Move or delete the entries/)
  })

  it('editing a group keeps its children', () => {
    const { data } = run([{ op: 'updateItem', at: { section: 0, index: 2 }, item: { label: 'Deployment', type: 'group' } }])
    expect(data.sections[0].items[2].label).toBe('Deployment')
    expect(data.sections[0].items[2].items).toHaveLength(1)
  })

  it('deletes an item', () => {
    const { data } = run([{ op: 'deleteItem', at: { section: 0, index: 1 } }])
    expect(labels(data, 0)).toEqual(['IFC Checker', 'Deploy'])
  })
})

describe('moveItem', () => {
  it('reorders within a list (arrayMove) and carries the comment', () => {
    const { data, text } = run([{ op: 'moveItem', from: { section: 0, index: 0 }, to: { section: 0 }, index: 2 }])
    expect(labels(data, 0)).toEqual(['Site', 'Deploy', 'IFC Checker'])
    expect(text.indexOf('# The checker, keep first')).toBeGreaterThan(text.indexOf('label: Deploy'))
    expect(text.indexOf('# The checker, keep first')).toBeLessThan(text.indexOf('label: IFC Checker'))
  })

  it('moves to another heading', () => {
    const { data } = run([{ op: 'moveItem', from: { section: 0, index: 1 }, to: { section: 1 }, index: 0 }])
    expect(labels(data, 0)).toEqual(['IFC Checker', 'Deploy'])
    expect(labels(data, 1)).toEqual(['Site'])
  })

  it('moves into a group that sits after the item in the same list', () => {
    // Removing index 0 shifts the group from 2 to 1; the target must still be the group.
    const { data } = run([{ op: 'moveItem', from: { section: 0, index: 0 }, to: { section: 0, group: 2 }, index: 1 }])
    expect(labels(data, 0)).toEqual(['Site', 'Deploy'])
    expect(data.sections[0].items[1].items.map((i: any) => i.label)).toEqual(['Runbook', 'IFC Checker'])
  })

  it('moves out of a group', () => {
    const { data } = run([{ op: 'moveItem', from: { section: 0, group: 2, index: 0 }, to: { section: 1 }, index: 0 }])
    expect(data.sections[0].items[2].items).toEqual([])
    expect(labels(data, 1)).toEqual(['Runbook'])
  })

  it('refuses to move a group into a group', () => {
    const source = SOURCE.replace('  - title: Docs\n    items:\n', '  - title: Docs\n    items:\n      - { label: G2, type: group, items: [] }\n')
    expect(() =>
      run([{ op: 'moveItem', from: { section: 0, index: 2 }, to: { section: 1, group: 0 }, index: 0 }], source),
    ).toThrow(/cannot contain another group/)
  })
})

describe('daily entries', () => {
  it('adds a daily entry with only the fields given', () => {
    const { data } = run([{ op: 'addItem', to: { section: 1 }, item: { label: 'Today', type: 'daily', folder: '', template: '' } }])
    expect(data.sections[1].items[0]).toEqual({ label: 'Today', type: 'daily' })
  })

  it('keeps folder and template when set', () => {
    const { data } = run([{ op: 'addItem', to: { section: 1 }, item: { label: 'Log', type: 'daily', folder: 'journal' } }])
    expect(data.sections[1].items[0]).toEqual({ label: 'Log', type: 'daily', folder: 'journal' })
  })
})

describe('setProfileField', () => {
  it('adds notes after accent, keeping comments, and leaves sections last', () => {
    const { data, text } = run([{ op: 'setProfileField', key: 'notes', value: '~/Documents/work/notes' }])
    expect(data.notes).toBe('~/Documents/work/notes')
    expect(text).toContain('# Work profile')
    expect(text).toContain('# The checker, keep first')
    expect(text.indexOf('notes: ~/Documents/work/notes')).toBeGreaterThan(text.indexOf('accent:'))
    expect(text.indexOf('notes: ~/Documents/work/notes')).toBeLessThan(text.indexOf('sections:'))
  })

  it('places a new key after home when home is set', () => {
    const { text } = run([{ op: 'setProfileField', key: 'notes', value: '~/n' }], SOURCE.replace('accent: "#7d93ab"\n', 'accent: "#7d93ab"\nhome: ~/w # where I work\n'))
    expect(text).toMatch(/home: ~\/w # where I work\nnotes: ~\/n\nsections:/)
  })

  it('replaces an existing value in place', () => {
    const { text } = run([{ op: 'setProfileField', key: 'notes', value: '~/b' }], SOURCE.replace('name: Work\n', 'name: Work\nnotes: ~/a # mine\n'))
    expect(text).toContain('notes: ~/b # mine')
  })

  it('removes an optional key when the value is empty', () => {
    const { data } = run([{ op: 'setProfileField', key: 'notes', value: '  ' }], SOURCE.replace('name: Work\n', 'name: Work\nnotes: ~/a\n'))
    expect(data.notes).toBeUndefined()
  })

  it('quotes a bare ~ so it does not become null', () => {
    const { data } = run([{ op: 'setProfileField', key: 'home', value: '~' }])
    expect(data.home).toBe('~')
  })

  it('validates the result', () => {
    expect(() => run([{ op: 'setProfileField', key: 'accent', value: 'teal' }])).toThrow(/accent/)
    expect(() => run([{ op: 'setProfileField', key: 'name', value: '' }])).toThrow(OpError)
  })
})

describe('project cards', () => {
  const at = { section: 0, index: 0 }

  it('sets card fields on a folder entry, keeping comments', () => {
    const { data, text } = run([
      { op: 'setCard', at, field: 'description', value: 'Checks IFC models' },
      { op: 'setCard', at, field: 'status', value: 'paused' },
      { op: 'setCard', at, field: 'category', value: 'client' },
      { op: 'setCard', at, field: 'pinned', value: true },
    ])
    expect(data.sections[0].items[0]).toMatchObject({ description: 'Checks IFC models', status: 'paused', category: 'client', pinned: true })
    expect(text).toContain('# The checker, keep first')
    expect(text).toContain('# custom key the app does not manage')
  })

  it('removes a field with null, and an empty description', () => {
    const source = SOURCE.replace('owner: me', 'status: done\n        description: old\n        owner: me')
    const { data } = run(
      [
        { op: 'setCard', at, field: 'status', value: null },
        { op: 'setCard', at, field: 'description', value: '  ' },
      ],
      source,
    )
    expect(data.sections[0].items[0].status).toBeUndefined()
    expect(data.sections[0].items[0].description).toBeUndefined()
  })

  it('validates the value and the entry', () => {
    expect(() => run([{ op: 'setCard', at, field: 'status', value: 'someday' }])).toThrow(/status/)
    expect(() => run([{ op: 'setCard', at, field: 'pinned', value: 'yes' }])).toThrow(OpError)
    expect(() => run([{ op: 'setCard', at: { section: 0, index: 1 }, field: 'status', value: 'done' }])).toThrow(/folder/)
  })

  it('keeps card fields when the entry is edited in the dialog', () => {
    const { data } = run([
      { op: 'setCard', at, field: 'category', value: 'client' },
      { op: 'updateItem', at, item: { label: 'IFC', type: 'folder', path: '~/ifc' } },
    ])
    expect(data.sections[0].items[0]).toMatchObject({ label: 'IFC', category: 'client' })
  })

  it('no longer knows project entries', () => {
    expect(() => run([{ op: 'addItem', to: { section: 1 }, item: { label: 'Card', type: 'project', project: 'x' } as never }])).toThrow(OpError)
  })
})

describe('comments on a key line', () => {
  it('stay on the line of a key whose value is a block list or map', () => {
    const source = SOURCE.replace('sections:\n', 'sections: # headings, in nav order\n')
    const doc = parseDocument(source)
    applyOps(doc, [{ op: 'addSection', title: 'Tools' }], source)
    expect(doc.toString()).toContain('sections: # headings, in nav order\n  # Things I build\n')
  })
})
