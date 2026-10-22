import { describe, expect, it } from 'vitest'
import { Profile } from '../shared/config-schema.ts'
import { entryId, resolveEntry } from '../src/lib/nav.ts'

const profile = (sections: unknown) => Profile.parse({ name: 'W', sections })

const before = profile([
  { title: 'Projects', items: [{ label: 'Alpha', type: 'folder', path: '~/alpha' }, { label: 'Beta', type: 'folder', path: '~/beta' }] },
  { title: 'Notes', items: [{ label: 'Ideas', type: 'note', path: '~/notes/Ideas.md' }] },
])
const beta = entryId(before.sections[0].items[1])

describe('an entry is found again after it moves', () => {
  it('stays where it is when nothing moved', () => {
    expect(resolveEntry(before, '0.1', beta)).toEqual({ section: 0, index: 1 })
  })

  it('is found at its new address after a move, even into a group', () => {
    const moved = profile([
      { title: 'Projects', items: [{ label: 'Alpha', type: 'folder', path: '~/alpha' }] },
      { title: 'Notes', items: [{ label: 'Old', type: 'group', items: [{ label: 'Beta', type: 'folder', path: '~/beta' }] }, { label: 'Ideas', type: 'note', path: '~/notes/Ideas.md' }] },
    ])
    expect(resolveEntry(moved, '0.1', beta)).toEqual({ section: 1, group: 0, index: 0 })
  })

  it('is found after a rename by its path, and not confused with what took its place', () => {
    const renamed = profile([{ title: 'Projects', items: [{ label: 'Gamma', type: 'folder', path: '~/gamma' }, { label: 'Beta 2', type: 'folder', path: '~/beta' }] }])
    expect(resolveEntry(renamed, '0.1', entryId(before.sections[0].items[0]))).toBeNull()
    expect(resolveEntry(renamed, '0.1', beta)).toEqual({ section: 0, index: 1 })
    const gone = profile([{ title: 'Projects', items: [{ label: 'Gamma', type: 'folder', path: '~/gamma' }, { label: 'Delta', type: 'folder', path: '~/delta' }] }])
    expect(resolveEntry(gone, '0.1', beta)).toBeNull()
  })

  it('without an identity (older saved state), the address is trusted', () => {
    expect(resolveEntry(before, '1.0')).toEqual({ section: 1, index: 0 })
    expect(resolveEntry(before, '5.0')).toBeNull()
  })
})
