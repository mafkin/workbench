// The Ctrl+K quick switcher's items and matching: letters in order, with word
// starts and runs counting more; the label counts more than the detail.

export interface SwitchItem {
  id: string
  kind: 'entry' | 'step' | 'note' | 'context' | 'chat' | 'page' | 'action'
  label: string
  /** Where it is: a heading, a folder, a project. */
  detail: string
  run: () => void
}

export const KIND_LABEL: Record<SwitchItem['kind'], string> = {
  entry: 'entry',
  step: 'step',
  note: 'note',
  context: 'context',
  chat: 'chat',
  page: 'page',
  action: 'action',
}

/** A score for `query` in `text`: -1 when its letters are not all there in order, 0 for an empty query. */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return -1
    const wordStart = at === 0 || /[\s\-_/.›:]/.test(t[at - 1])
    run = at === ti ? run + 1 : 0
    score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(at - ti, 5) * 0.2
    ti = at + 1
  }
  // A match at the very start, and shorter texts, rank higher.
  if (t.startsWith(q)) score += 5
  return score - text.length * 0.01
}

/** Items matching `query`, best first; with no query, recent picks first, then the rest in order. */
export function rank(items: SwitchItem[], query: string, recent: string[], limit = 60): SwitchItem[] {
  if (!query.trim()) {
    const byId = new Map(items.map((i) => [i.id, i]))
    const first = recent.map((id) => byId.get(id)).filter((i): i is SwitchItem => !!i)
    return [...first, ...items.filter((i) => !recent.includes(i.id))].slice(0, limit)
  }
  const scored: { item: SwitchItem; score: number }[] = []
  for (const item of items) {
    const label = fuzzy(query, item.label)
    const detail = fuzzy(query, item.detail)
    const score = Math.max(label >= 0 ? label + 10 : -1, detail >= 0 ? detail * 0.5 : -1)
    if (score >= 0) scored.push({ item, score })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item)
}
