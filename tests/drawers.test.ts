import { describe, expect, it } from 'vitest'
import { drawersOf, folderRoots, getItem, itemKey, Profile } from '../shared/config-schema.ts'
import { parseKey, resolveEntry } from '../src/lib/nav.ts'

// The drawer ops themselves live in the wiki store (tests/wiki.test.ts); these are the schema's helpers.
const ONE = Profile.parse({ name: 'Work', sections: [{ title: 'Projects', items: [{ label: 'Tower', type: 'folder', path: '~/dev/tower' }] }] })
const TWO = Profile.parse({
  name: 'Work',
  drawers: [
    { name: 'Work', sections: [{ title: 'Projects', items: [{ label: 'Tower', type: 'folder', path: '~/dev/tower' }] }] },
    { name: 'Research', folder: '~/notes/drawers/research', sections: [{ title: 'Reading', items: [{ label: 'Papers', type: 'note', path: '~/p.md' }] }] },
  ],
})

describe('drawers in the schema', () => {
  it('a profile without drawers is one drawer named after it', () => {
    expect(drawersOf(ONE).map((d) => d.name)).toEqual(['Work'])
    expect(drawersOf(ONE)[0].sections[0].items[0].label).toBe('Tower')
    expect(drawersOf(TWO).map((d) => d.name)).toEqual(['Work', 'Research'])
  })

  it('a file with both sections and drawers, or two drawers of one name, is an error', () => {
    const both = Profile.safeParse({ name: 'W', sections: [{ title: 'A', items: [] }], drawers: [{ name: 'A', sections: [] }] })
    expect(both.success).toBe(false)
    expect(both.error?.issues[0].message).toMatch(/either sections: or drawers:/)
    const twice = Profile.safeParse({ name: 'W', drawers: [{ name: 'A' }, { name: 'a' }] })
    expect(twice.error?.issues[0].message).toMatch(/Two drawers are called a/)
  })

  it('addresses carry the drawer, and keys put it in front past the first one', () => {
    const at = { drawer: 1, section: 0, index: 0 }
    expect(getItem(TWO, at)?.label).toBe('Papers')
    expect(itemKey(at)).toBe('1:0.0')
    expect(itemKey({ drawer: 0, section: 0, group: 1, index: 0 })).toBe('0.1.0')
    expect(parseKey('1:0.0')).toEqual(at)
    expect(parseKey('0.1.0')).toEqual({ section: 0, group: 1, index: 0 })
    expect(parseKey('x:0.0')).toBeNull()
    // A moved entry is found again, in its own drawer first.
    expect(resolveEntry(TWO, '1:0.5', 'note|Papers|~/p.md')).toEqual(at)
  })

  it("a drawer's shared folder is one of the profile's folders", () => {
    expect(folderRoots(TWO)).toContainEqual({ label: 'Research (shared folder)', path: '~/notes/drawers/research' })
  })
})
