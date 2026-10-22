// One file's diff, unified: hunks with old and new line numbers, + and - lines
// in the theme's colours, and per-hunk buttons the caller supplies.
import type { GitDiff as Diff, Hunk } from '../../shared/git.ts'
import { cx } from '../lib/nav.ts'

export function GitDiff({ diff, actions }: { diff: Diff; actions?: (hunk: Hunk) => React.ReactNode }) {
  if (diff.binary) return <p className="git-diff-note">Binary file; it can only be staged or discarded as a whole.</p>
  if (diff.tooLarge) return <p className="git-diff-note">Too large to show; it can only be staged or discarded as a whole.</p>
  if (!diff.hunks.length) return <p className="git-diff-note">No changes to the text (only the file mode or name).</p>
  return (
    <div className="git-diff">
      {diff.hunks.map((h) => (
        <section key={h.id} className="git-hunk" aria-label={h.header}>
          <div className="git-hunk-head">
            <span className="mono">{h.header}</span>
            {actions && <span className="git-hunk-actions">{actions(h)}</span>}
          </div>
          <div className="git-lines mono" role="presentation">
            {h.lines.map((l, i) =>
              l.kind === '\\' ? (
                <div key={i} className="git-line note">
                  <span className="ln" />
                  <span className="ln" />
                  <span className="sign" />
                  <span className="text">{l.text}</span>
                </div>
              ) : (
                <div key={i} className={cx('git-line', l.kind === '+' && 'add', l.kind === '-' && 'del')}>
                  <span className="ln">{l.old ?? ''}</span>
                  <span className="ln">{l.new ?? ''}</span>
                  <span className="sign">{l.kind === ' ' ? '' : l.kind}</span>
                  <span className="text">{l.text}</span>
                </div>
              ),
            )}
          </div>
        </section>
      ))}
    </div>
  )
}
