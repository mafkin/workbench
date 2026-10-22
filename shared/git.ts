// Git per project (part 9): what the service reads from a project's repository
// and sends to the Git tab, the card and the nav. Paths in a repository are
// relative to its top folder, with `/`.

/** M modified, A added, D deleted, R renamed, C copied, T type changed, ? untracked, U conflicted. */
export type GitFileState = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | '?' | 'U'

export interface GitFile {
  path: string
  /** The old path of a rename or copy. */
  from?: string
  state: GitFileState
}

export interface GitConflict {
  path: string
  /** Git's two letters: UU both changed, AA both added, DU deleted by us, UD deleted by them… */
  code: string
}

export interface Stash {
  index: number
  hash: string
  /** Seconds since the epoch. */
  at: number
  message: string
}

/** What is in progress in the repository: a merge, or a stash applied with conflicts. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' | null

export interface GitStatus {
  /** The repository's top folder, `~/…` where it can be. */
  repo: string
  /** Where the project is inside the repository (`web/`), or '' at its top. */
  sub: string
  /** null when HEAD is detached. */
  branch: string | null
  /** Short hash of HEAD; null before the first commit. */
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  remotes: string[]
  staged: GitFile[]
  changes: GitFile[]
  conflicts: GitConflict[]
  operation: GitOperation
  /** The first line of the merge message, for the conflicts banner. */
  operationLabel: string | null
  stashes: Stash[]
  /** HEAD is already on a remote branch, so it can't be amended here. */
  headPushed: boolean
  lastFetch: { at: number; error: string | null } | null
}

export interface DiffLine {
  /** ' ' context, '+' added, '-' removed, '\\' a "No newline at end of file" note. */
  kind: ' ' | '+' | '-' | '\\'
  text: string
  old?: number
  new?: number
}

export interface Hunk {
  /** A hash of the hunk, which the service finds it by again before applying it. */
  id: string
  header: string
  lines: DiffLine[]
}

export interface GitDiff {
  file: string
  from?: string
  binary: boolean
  /** Over 1 MB or 5000 lines: not shown, and only whole-file actions. */
  tooLarge: boolean
  /** An untracked file: shown whole, staged only as a whole. */
  untracked: boolean
  hunks: Hunk[]
}

export interface Commit {
  hash: string
  short: string
  author: string
  email: string
  /** Seconds since the epoch. */
  at: number
  parents: string[]
  subject: string
}

export interface CommitFile extends GitFile {
  added: number | null
  removed: number | null
}

export interface CommitDetail extends Commit {
  body: string
  committer: string
  committedAt: number
  files: CommitFile[]
}

export interface Branch {
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  /** Seconds since the epoch, of its last commit. */
  at: number
  subject: string
}

export interface GitMark {
  /** The folder entry's path as written in the config. */
  path: string
  branch: string | null
  changed: number
  ahead: number
  behind: number
  conflicts: number
}

/** What a discard can be undone with. */
export interface DiscardResult {
  undo: string | null
  trashed: string[]
}
