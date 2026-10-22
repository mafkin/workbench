// Ticking a task in a note's view: the task's line, by its 1-based line number,
// with `[ ]` and `[x]` swapped. Anything that is not a task line is left alone.

const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/

export function toggleTaskLine(text: string, line: number): string | null {
  const lines = text.split('\n')
  const i = line - 1
  const m = i >= 0 && i < lines.length ? TASK.exec(lines[i]) : null
  if (!m) return null
  lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[i].slice(m[0].length)}`
  return lines.join('\n')
}
