// Recent work for Home: what was opened last in this browser, per profile.
// Entry keys are addresses; each item also keeps the entry's identity, so an
// entry that moved is found at its new place, and one that is gone is skipped.

export interface Recent {
  /** A selection key: an entry address, `note:<path>` or `files:<path>`. */
  key: string
  /** A project's workflow step, by label. */
  step?: string
  label: string
  /** The entry's identity (entryId), so it is found again after a move. */
  entry?: string
  at: number
}

export const MAX_RECENT = 12

export function pushRecent(list: Recent[], item: Recent): Recent[] {
  const same = (r: Recent) => r.step === item.step && (r.key === item.key || (!!item.entry && r.entry === item.entry))
  return [item, ...list.filter((r) => !same(r))].slice(0, MAX_RECENT)
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
