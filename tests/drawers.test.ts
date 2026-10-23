import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps } from '../server/config-ops.ts'
import { projectsOf } from '../server/git.ts'
import { drawersOf, entryAt, folderRoots, getItem, itemKey, Profile, sharedRefs, type Op } from '../shared/config-schema.ts'
import { parseKey, resolveEntry } from '../src/lib/nav.ts'

const SOURCE = `# Work profile
name: Work
accent: "#7d93ab"
sections: # headings, in nav order
  # Things I build
  - title: Projects
    items:
      - { label: Tower, type: folder, path: ~/dev/tower }
      - label: Deploy
        type: group
        items:
          - { label: Runbook, type: note, path: ~/RUNBOOK.md }
  - title: Notes
    items:
      - { label: Ideas, type: note, path: ~/notes/ideas.md }
`

function run(ops: Op[], source = SOURCE) {
  const doc = parseDocument(source)
  applyOps(doc, ops, source)
  return { text: doc.toString(), profile: Profile.parse(doc.toJS()) }
}

/** The fixture with a second drawer, Research. */
const TWO = run([{ op: 'addDrawer', name: 'Research' }]).text
const TOWER = { section: 0, index: 0 }

describe('drawers in the file', () => {
  it('a profile without drawers is one drawer named after it', () => {
    const p = Profile.parse(parseDocument(SOURCE).toJS())
    expect(drawersOf(p).map((d) => d.name)).toEqual(['Work'])
    expect(getItem(p, TOWER)?.label).toBe('Tower')
  })

  it('the first drawer op moves sections into a first drawer, comments and all, in the same place', () => {
    const { text, profile } = run([{ op: 'addDrawer', name: 'Research' }])
    expect(text).toContain(`accent: "#7d93ab"
drawers:
  - name: Work
    sections: # headings, in nav order
      # Things I build
      - title: Projects
`)
    expect(text).toContain('  - name: Research\n    sections: []\n')
    expect(profile.sections).toEqual([])
    expect(drawersOf(profile).map((d) => d.sections.length)).toEqual([2, 0])
  })

  it('refuses a second drawer of the same name, ignoring case, and an empty or long name', () => {
    expect(() => run([{ op: 'addDrawer', name: 'research' }], TWO)).toThrow(/already a drawer called research/)
    expect(() => run([{ op: 'addDrawer', name: '  ' }])).toThrow(/needs a name/)
    expect(() => run([{ op: 'addDrawer', name: 'x'.repeat(41) }])).toThrow(/at most 40/)
  })

  it('a file with both sections and drawers, or two drawers of one name, is an error', () => {
    const both = Profile.safeParse({ name: 'W', sections: [{ title: 'A', items: [] }], drawers: [{ name: 'A', sections: [] }] })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0].message).toMatch(/either sections: or drawers:/)
    const twice = Profile.safeParse({ name: 'W', drawers: [{ name: 'A' }, { name: 'a' }] })
    expect(twice.error?.issues[0].message).toMatch(/Two drawers are called a/)
  })

  it('addresses carry the drawer, and keys put it in front past the first one', () => {
    const { profile } = run([{ op: 'addSection', drawer: 1, title: 'Reading' }, { op: 'addItem', to: { drawer: 1, section: 0 }, item: { label: 'Papers', type: 'note', path: '~/p.md' } }], TWO)
    const at = { drawer: 1, section: 0, index: 0 }
    expect(getItem(profile, at)?.label).toBe('Papers')
    expect(itemKey(at)).toBe('1:0.0')
    expect(itemKey({ drawer: 0, section: 0, group: 1, index: 0 })).toBe('0.1.0')
    expect(parseKey('1:0.0')).toEqual(at)
    expect(parseKey('0.1.0')).toEqual({ section: 0, group: 1, index: 0 })
    expect(parseKey('x:0.0')).toBeNull()
    // A moved entry is found again, in its own drawer first.
    expect(resolveEntry(profile, '1:0.5', 'note|Papers|~/p.md')).toEqual(at)
  })

  it('a drawer past the last one is refused, and entries move only within their drawer', () => {
    expect(() => run([{ op: 'addSection', drawer: 1, title: 'X' }])).toThrow(/Drawer 1 does not exist/)
    const two = run([{ op: 'addSection', drawer: 1, title: 'Reading' }], TWO).text
    expect(() => run([{ op: 'moveItem', from: TOWER, to: { drawer: 1, section: 0 }, index: 0 }], two)).toThrow(/within their drawer/)
  })

  it('setDrawer sets a logo, folder and uses before sections, and an empty value removes them', () => {
    const { text, profile } = run(
      [
        { op: 'setDrawer', drawer: 1, field: 'logo', value: '0123456789ab.png' },
        { op: 'setDrawer', drawer: 1, field: 'folder', value: '~/notes/drawers/research' },
        { op: 'setDrawer', drawer: 0, field: 'uses', value: ['Research'] },
      ],
      TWO,
    )
    expect(text).toContain('  - name: Research\n    logo: 0123456789ab.png\n    folder: ~/notes/drawers/research\n    sections: []')
    expect(text).toContain('  - name: Work\n    uses: [ Research ]\n    sections:')
    expect(drawersOf(profile)[0].uses).toEqual(['Research'])
    expect(folderRoots(profile).at(-1)).toEqual({ label: 'Research (shared folder)', path: '~/notes/drawers/research' })
    const cleared = run([{ op: 'setDrawer', drawer: 1, field: 'logo', value: '' }, { op: 'setDrawer', drawer: 0, field: 'uses', value: [] }], text).profile
    expect(drawersOf(cleared)[1].logo).toBeUndefined()
    expect(drawersOf(cleared)[0].uses).toBeUndefined()
  })

  it('setDrawer on a profile without drawers moves its sections first', () => {
    const { profile } = run([{ op: 'setDrawer', drawer: 0, field: 'name', value: 'Game dev' }])
    expect(drawersOf(profile).map((d) => d.name)).toEqual(['Game dev'])
    expect(getItem(profile, TOWER)?.label).toBe('Tower')
  })
})

describe('shared entries', () => {
  const shared = run([{ op: 'setShared', at: TOWER, drawer: 1, on: true }], TWO)
  const REF = { drawer: 1, section: 0, index: 0 }

  it('land under a heading of the same title, added when missing, and lead to the original', () => {
    expect(shared.text).toContain('  - name: Research\n    sections:\n      - title: Projects\n        items:\n          - label: Tower\n            type: shared\n            drawer: Work\n            path: ~/dev/tower\n')
    expect(getItem(shared.profile, REF)?.type).toBe('shared')
    expect(entryAt(shared.profile, REF)).toEqual({ addr: TOWER, item: getItem(shared.profile, TOWER) })
    expect(sharedRefs(shared.profile, TOWER).map((r) => r.addr)).toEqual([REF])
    // Sharing again is a no-op; projects are not counted twice.
    expect(run([{ op: 'setShared', at: TOWER, drawer: 1, on: true }], shared.text).text).toBe(shared.text)
    expect(projectsOf(shared.profile).map((p) => p.label)).toEqual(['Tower'])
  })

  it('reuse a heading of the same title', () => {
    const { profile } = run([{ op: 'addSection', drawer: 1, title: 'projects' }, { op: 'setShared', at: TOWER, drawer: 1, on: true }], TWO)
    expect(drawersOf(profile)[1].sections.map((s) => s.items.length)).toEqual([1])
  })

  it('are refused for groups, shared entries and their own drawer', () => {
    expect(() => run([{ op: 'setShared', at: { section: 0, index: 1 }, drawer: 1, on: true }], TWO)).toThrow(/Groups are not shared/)
    expect(() => run([{ op: 'setShared', at: TOWER, drawer: 0, on: true }], TWO)).toThrow(/already in this drawer/)
    expect(() => run([{ op: 'setShared', at: REF, drawer: 0, on: true }], shared.text)).toThrow(/already shared/)
  })

  it('stop showing with on: false', () => {
    const { profile } = run([{ op: 'setShared', at: TOWER, drawer: 1, on: false }], shared.text)
    expect(sharedRefs(profile, TOWER)).toEqual([])
  })

  it('follow a rename of the original, and go when it is deleted', () => {
    const renamed = run([{ op: 'updateItem', at: TOWER, item: { label: 'Spire', type: 'folder', path: '~/dev/spire' } }], shared.text)
    expect(getItem(renamed.profile, REF)).toMatchObject({ label: 'Spire', path: '~/dev/spire', drawer: 'Work' })
    expect(entryAt(renamed.profile, REF)?.item.label).toBe('Spire')
    const deleted = run([{ op: 'deleteItem', at: TOWER }], shared.text)
    expect(drawersOf(deleted.profile)[1].sections[0].items).toEqual([])
  })

  it('follow a drawer rename, and go with a deleted drawer; uses lists follow too', () => {
    const withUses = run([{ op: 'setDrawer', drawer: 1, field: 'uses', value: ['work'] }], shared.text).text
    const renamed = run([{ op: 'setDrawer', drawer: 0, field: 'name', value: 'Game dev' }], withUses).profile
    expect(getItem(renamed, REF)).toMatchObject({ drawer: 'Game dev' })
    expect(drawersOf(renamed)[1].uses).toEqual(['Game dev'])
    expect(entryAt(renamed, REF)?.item.label).toBe('Tower')

    const gone = run([{ op: 'addDrawer', name: 'Third' }, { op: 'deleteDrawer', drawer: 0 }], withUses).profile
    expect(drawersOf(gone).map((d) => d.name)).toEqual(['Research', 'Third'])
    expect(drawersOf(gone)[0].sections[0].items).toEqual([])
    expect(drawersOf(gone)[0].uses).toBeUndefined()
  })

  it('a missing original leaves the shared entry pointing nowhere', () => {
    const p = Profile.parse({ name: 'W', drawers: [{ name: 'A', sections: [{ title: 'X', items: [{ label: 'Gone', type: 'shared', drawer: 'B' }] }] }] })
    expect(entryAt(p, { section: 0, index: 0 })).toBeNull()
  })

  it('the last drawer stays', () => {
    expect(() => run([{ op: 'deleteDrawer', drawer: 0 }], TWO.replace(/  - name: Research\n    sections: \[\]\n/, ''))).toThrow(/at least one drawer/)
  })
})

describe('new top-level keys', () => {
  it('go before drawers:', () => {
    const { text } = run([{ op: 'setCategory', name: 'Games', color: '#b39b78' }], TWO)
    expect(text).toMatch(/categories:\n {2}Games: "#b39b78"\ndrawers:/)
  })
})
