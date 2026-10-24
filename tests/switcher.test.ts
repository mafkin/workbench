import { describe, expect, it } from 'vitest'
import { fuzzy, rank, type SwitchItem } from '../src/lib/switcher.ts'

const item = (label: string, detail = '', kind: SwitchItem['kind'] = 'entry'): SwitchItem => ({ id: `${kind}:${label}`, kind, label, detail, run: () => {} })

describe('the quick switcher’s matching', () => {
  it('matches letters in order, and nothing else', () => {
    expect(fuzzy('alp', 'Alpha')).toBeGreaterThan(0)
    expect(fuzzy('ahp', 'Alpha')).toBe(-1)
    expect(fuzzy('', 'Alpha')).toBe(0)
  })

  it('ranks word starts and runs higher', () => {
    expect(fuzzy('nc', 'New chat in Alpha')).toBeGreaterThan(fuzzy('nc', 'Runbook notes'))
    expect(fuzzy('read', 'readme')).toBeGreaterThan(fuzzy('read', 'r-e-a-d'))
  })

  it('ranks by label first, then detail, and keeps recent picks first for an empty query', () => {
    const items = [item('Ideas', 'Notes'), item('Alpha', 'Projects'), item('Deploy plan', 'alpha notes', 'note'), item('New chat in Alpha', '', 'action')]
    expect(rank(items, 'alpha', []).map((i) => i.label)).toEqual(['Alpha', 'New chat in Alpha', 'Deploy plan'])
    expect(rank(items, '', ['action:New chat in Alpha', 'note:Deploy plan']).map((i) => i.label)).toEqual(['New chat in Alpha', 'Deploy plan', 'Ideas', 'Alpha'])
  })
})
