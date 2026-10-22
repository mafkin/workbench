import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { applyOps } from '../server/config-ops.ts'
import { Profile, type Op } from '../shared/config-schema.ts'

const SOURCE = `name: Work
# Every project starts with these
workflow: []
sections:
  - title: Projects
    items:
      - { label: Alpha, type: folder, path: ~/alpha, category: Games }
`

function run(ops: Op[], source = SOURCE) {
  const doc = parseDocument(source)
  applyOps(doc, ops, source)
  const text = doc.toString()
  return { text, profile: Profile.parse(doc.toJS()) }
}

describe('category colours', () => {
  it('adds categories: before the sections, keeping comments', () => {
    const { text, profile } = run([{ op: 'setCategory', name: 'Games', color: '#b39b78' }])
    expect(profile.categories).toEqual({ Games: '#b39b78' })
    expect(text.indexOf('categories:')).toBeLessThan(text.indexOf('sections:'))
    expect(text).toContain('# Every project starts with these')
  })

  it('changes and removes a colour; the last one removes the key', () => {
    const { text } = run([{ op: 'setCategory', name: 'Games', color: '#b39b78' }])
    expect(run([{ op: 'setCategory', name: 'Games', color: '#7d93ab' }], text).profile.categories).toEqual({ Games: '#7d93ab' })
    expect(run([{ op: 'setCategory', name: 'Games', color: null }], text).text).not.toContain('categories')
  })

  it('refuses a colour that is not #rrggbb', () => {
    expect(() => run([{ op: 'setCategory', name: 'Games', color: 'red' } as unknown as Op])).toThrow()
  })
})
