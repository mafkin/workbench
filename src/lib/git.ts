// Small helpers for the Git tab.
import type { GitFile, GitFileState, GitStatus } from '../../shared/git.ts'

export const STATE_LABEL: Record<GitFileState, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  '?': 'New',
  U: 'Conflict',
}

/** What git's two-letter conflict code means, for the banner. */
export const CONFLICT_LABEL: Record<string, string> = {
  UU: 'both changed',
  AA: 'both added',
  DU: 'deleted here',
  UD: 'deleted there',
  AU: 'added here',
  UA: 'added there',
  DD: 'deleted on both sides',
}

/** `src/app.ts` → name `app.ts`, folder `src/`. */
export function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i + 1) }
}

/** A file in the repository as a path the rest of the app takes (`~/code/src/a.ts`). */
export const inRepo = (status: GitStatus, file: string) => `${status.repo.replace(/\/$/, '')}/${file}`

/** The changed paths, counted once even when staged and changed again. */
export const changedCount = (s: GitStatus) => new Set([...s.staged, ...s.changes].map((f: GitFile) => f.path)).size + s.conflicts.length
