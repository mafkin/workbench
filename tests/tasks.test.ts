import { describe, expect, it } from 'vitest'
import { toggleTaskLine } from '../src/lib/tasks.ts'

const NOTE = '# Plan\n\n- [ ] Write it\n- [x] Ship it\n  1. [ ] nested\n> - [ ] quoted\nplain [ ] text\n'

describe('ticking a task line', () => {
  it('swaps [ ] and [x] on that line only', () => {
    expect(toggleTaskLine(NOTE, 3)).toBe(NOTE.replace('- [ ] Write it', '- [x] Write it'))
    expect(toggleTaskLine(NOTE, 4)).toBe(NOTE.replace('- [x] Ship it', '- [ ] Ship it'))
    expect(toggleTaskLine(NOTE, 5)).toBe(NOTE.replace('1. [ ] nested', '1. [x] nested'))
    expect(toggleTaskLine(NOTE, 6)).toBe(NOTE.replace('> - [ ] quoted', '> - [x] quoted'))
  })

  it('leaves lines that are not tasks', () => {
    expect(toggleTaskLine(NOTE, 1)).toBeNull()
    expect(toggleTaskLine(NOTE, 7)).toBeNull()
    expect(toggleTaskLine(NOTE, 99)).toBeNull()
  })
})
