// Recent work for Home: what was opened last in this browser, per profile.
// Entry keys are addresses, so each item keeps the label it had, and one whose
// address now holds something else is skipped.

export interface Recent {
  /** A selection key: an entry address, `note:<path>` or `files:<path>`. */
  key: string
  /** A project's workflow step, by label. */
  step?: string
  label: string
  at: number
}

export const MAX_RECENT = 12

export function pushRecent(list: Recent[], item: Recent): Recent[] {
  return [item, ...list.filter((r) => r.key !== item.key || r.step !== item.step)].slice(0, MAX_RECENT)
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or a date. */
export function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  if (h < 48) return 'yesterday'
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
