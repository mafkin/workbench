// The Git tab of a project in a repository (a lazy chunk). Left: the branch
// bar (switch, fetch, pull, push), conflicts when there are any, staged files
// and changes, the commit box (with Draft from claude), stashes and history.
// Right: the selected file's diff with buttons per hunk, or a commit's details.
// Status is read again every 3 s while the tab is open, and after each action.
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  MessageSquare,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Branch, Commit, CommitDetail, GitDiff as Diff, GitFile, GitStatus, Hunk, Stash } from '../../shared/git.ts'
import { ApiError } from '../lib/api.ts'
import * as api from '../lib/api.ts'
import { useChats } from '../lib/chats.ts'
import { CONFLICT_LABEL, inRepo, splitPath, STATE_LABEL } from '../lib/git.ts'
import { useLocal } from '../lib/local.ts'
import { cx, type MenuEntry, type MenuState } from '../lib/nav.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { ago } from '../lib/recent.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { GitDiff } from './GitDiff.tsx'
import type { ToastInput } from './Toast.tsx'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p)

type Selection =
  | { kind: 'file'; file: string; staged: boolean }
  | { kind: 'commit'; hash: string; file?: string }
  | { kind: 'stash'; stash: Stash; file?: string }

interface Confirm {
  title: string
  action: string
  body: React.ReactNode
  run: () => void
}

interface Choice {
  title: string
  body: React.ReactNode
  options: { label: string; primary?: boolean; run: () => void }[]
}

interface Ask {
  title: string
  label: string
  initial: string
  action: string
  optional?: boolean
  run: (value: string) => void
}

interface Props {
  profileId: string
  /** The project's path as written in the config. */
  path: string
  toast: (t: ToastInput) => void
  /** After anything that may change the nav's marks. */
  onChanged?: () => void
}

export default function GitView({ profileId, path, toast, onChanged }: Props) {
  const at = useMemo(() => ({ profile: profileId, path }), [profileId, path])
  const notes = useNotes()
  const chats = useChats()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [sel, setSel] = useState<Selection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useLocal(`gitMessage:${profileId}|${path}`, '')
  const [amend, setAmend] = useState(false)
  const [history, setHistory] = useState<Commit[] | null>(null)
  const [more, setMore] = useState(true)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const live = useRef(true)

  const load = useCallback(async () => {
    try {
      const s = await api.git.status(at)
      if (!live.current) return
      setStatus(s)
      setError(null)
      setTick((t) => t + 1)
    } catch (err) {
      if (live.current) setError(message(err))
    }
  }, [at])

  useEffect(() => {
    live.current = true
    void load()
    // Opening the tab fetches once, quietly; a failure shows in the bar.
    api.git.fetch(at, true).then(
      (r) => live.current && setStatus(r.status),
      () => {},
    )
    const poll = setInterval(load, 3000)
    return () => {
      live.current = false
      clearInterval(poll)
    }
  }, [at, load])

  // History follows HEAD and the branch.
  const headKey = status ? `${status.branch}|${status.head}` : ''
  useEffect(() => {
    if (!headKey) return
    api.git.log(at).then(
      (list) => {
        if (!live.current) return
        setHistory(list)
        setMore(list.length === 200)
      },
      () => {},
    )
  }, [at, headKey])

  /** Run an action; its answer's status replaces ours. A 409 with data goes to `onConflict`. */
  async function act<T extends object>(label: string, fn: () => Promise<T>, onConflict?: (err: ApiError) => boolean): Promise<T | null> {
    setBusy(label)
    try {
      const r = await fn()
      if ('status' in r && live.current) {
        setStatus(r.status as GitStatus)
        setTick((t) => t + 1)
      }
      onChanged?.()
      return r
    } catch (err) {
      if (err instanceof ApiError && onConflict?.(err)) return null
      toast({ message: message(err), kind: 'error' })
      void load()
      return null
    } finally {
      if (live.current) setBusy(null)
    }
  }

  // Files

  const stageFiles = (files: string[]) => act('stage', () => api.git.stage(at, { files }))
  const unstageFiles = (files: string[]) => act('unstage', () => api.git.unstage(at, { files }))

  const undoToast = (what: string, undo: string | null) =>
    toast({
      message: what,
      action: undo
        ? {
            label: 'Undo',
            run: () =>
              void act('undo', () => api.git.undo(at, undo)).then((r) => {
                if (r?.skipped.length) toast({ message: r.skipped.map((s) => `${s.path}: ${s.reason}`).join('; '), kind: 'error' })
              }),
          }
        : undefined,
    })

  function discardFiles(files: GitFile[]) {
    const untracked = files.filter((f) => f.state === '?')
    const one = files.length === 1 ? files[0].path : `${files.length} files`
    setConfirm({
      title: `Discard changes to ${one}?`,
      action: 'Discard',
      body: (
        <>
          {untracked.length === files.length ? 'New files go to the Trash.' : 'Your edits go back to the last staged or committed version.'} Undo in the message that follows puts
          them back.
        </>
      ),
      run: async () => {
        setConfirm(null)
        const r = await act('discard', () => api.git.discard(at, { files: files.map((f) => f.path) }))
        if (r) undoToast(`Discarded changes to ${one}`, r.undo)
      },
    })
  }

  function hunkAction(file: string, hunk: Hunk, how: 'stage' | 'unstage' | 'discard') {
    const req = { hunk: { file, id: hunk.id } }
    if (how === 'stage') return act('stage', () => api.git.stage(at, req))
    if (how === 'unstage') return act('unstage', () => api.git.unstage(at, req))
    setConfirm({
      title: 'Discard this hunk?',
      action: 'Discard',
      body: <>The lines go back to their last staged version; Undo in the message that follows puts them back.</>,
      run: async () => {
        setConfirm(null)
        const r = await act('discard', () => api.git.discard(at, req))
        if (r) undoToast(`Discarded a hunk of ${splitPath(file).name}`, r.undo)
      },
    })
  }

  // Commit

  async function commit() {
    if (!msg.trim() || busy) return
    const r = await act('commit', () => api.git.commit(at, msg, amend))
    if (r) {
      setMsg('')
      setAmend(false)
      toast({ message: `${amend ? 'Amended' : 'Committed'} ${r.commit.short}: ${r.commit.subject}` })
    }
  }

  async function draft() {
    const r = await act('draft', () => api.git.draft(at))
    if (r) setMsg(r.message)
  }

  async function toggleAmend(on: boolean) {
    setAmend(on)
    if (!on || msg.trim() || !history?.[0]) return
    try {
      const d = await api.git.commitDetail(at, history[0].hash)
      setMsg(d.body ? `${d.subject}\n\n${d.body}` : d.subject)
    } catch {
      // Keep the box empty.
    }
  }

  // Branches

  async function switchTo(name: string, carry?: 'carry' | 'stash') {
    await act(
      'switch',
      () => api.git.branch(at, { action: 'switch', name, carry }),
      (err) => {
        if (!err.data.dirty) return false
        setChoice({
          title: `Switch to ${name}?`,
          body: 'You have uncommitted changes. Bring them along to the other branch, or put them in a stash first (Pop brings them back).',
          options: [
            { label: 'Stash them first', run: () => void switchTo(name, 'stash') },
            { label: 'Bring them along', primary: true, run: () => void switchTo(name, 'carry') },
          ],
        })
        return true
      },
    )
  }

  async function deleteBranch(name: string, force = false) {
    await act(
      'delete',
      () => api.git.branch(at, { action: 'delete', name, force }),
      (err) => {
        if (!err.data.confirm) return false
        const lost = (err.data.lost as string[]) ?? []
        setConfirm({
          title: `Delete ${name} anyway?`,
          action: 'Delete anyway',
          body: (
            <>
              These commits are on no other branch and would be lost:
              <ul className="git-lost mono">
                {lost.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          ),
          run: () => {
            setConfirm(null)
            void deleteBranch(name, true)
          },
        })
        return true
      },
    )
  }

  async function branchMenu(e: React.MouseEvent) {
    const r = e.currentTarget.getBoundingClientRect()
    let list: Branch[]
    try {
      list = await api.git.branches(at)
    } catch (err) {
      return toast({ message: message(err), kind: 'error' })
    }
    const local = list.filter((b) => !b.remote)
    const remote = list.filter((b) => b.remote && !local.some((l) => l.name === b.name.slice(b.name.indexOf('/') + 1)))
    const current = local.find((b) => b.current)
    const entries: (MenuEntry | 'sep')[] = local.map((b) => ({
      label: b.name,
      icon: b.current ? <Check size={14} /> : <GitBranch size={14} />,
      detail: [b.ahead && `↑${b.ahead}`, b.behind && `↓${b.behind}`, ago(b.at * 1000)].filter(Boolean).join(' '),
      disabled: b.current,
      run: () => void switchTo(b.name),
    }))
    if (remote.length) {
      entries.push('sep')
      for (const b of remote) entries.push({ label: b.name, icon: <GitBranch size={14} />, detail: ago(b.at * 1000), run: () => void switchTo(b.name) })
    }
    entries.push('sep', {
      label: 'New branch…',
      icon: <Plus size={14} />,
      run: () =>
        setAsk({
          title: 'New branch',
          label: `Starts from ${status?.branch ?? 'HEAD'}; your changes come along`,
          initial: '',
          action: 'Create',
          run: (name) => void act('create', () => api.git.branch(at, { action: 'create', name })),
        }),
    })
    if (current) {
      entries.push({
        label: `Rename ${current.name}…`,
        run: () =>
          setAsk({
            title: `Rename ${current.name}`,
            label: 'New name',
            initial: current.name,
            action: 'Rename',
            run: (to) => void act('rename', () => api.git.branch(at, { action: 'rename', name: current.name, to })),
          }),
      })
    }
    const others = local.filter((b) => !b.current)
    if (others.length) {
      entries.push('sep')
      for (const b of others) {
        entries.push({
          label: `Delete ${b.name}…`,
          icon: <Trash2 size={14} />,
          danger: true,
          run: () =>
            setConfirm({
              title: `Delete the branch ${b.name}?`,
              action: 'Delete',
              body: 'Only the branch name goes; if it has commits that are on no other branch, you are asked again.',
              run: () => {
                setConfirm(null)
                void deleteBranch(b.name)
              },
            }),
        })
      }
    }
    setMenu({ x: r.left, y: r.bottom + 4, entries })
  }

  // Remote

  async function pull() {
    await act(
      'pull',
      () => api.git.pull(at),
      (err) => {
        if (!err.data.diverged) return false
        setConfirm({
          title: 'Merge to pull?',
          action: 'Merge',
          body: (
            <>
              {err.message}. Merging makes a merge commit; if both sides changed the same lines, you get conflicts to resolve here first.
            </>
          ),
          run: async () => {
            setConfirm(null)
            const r = await act('pull', () => api.git.pull(at, true))
            if (r?.conflicts) toast({ message: 'The merge has conflicts; resolve them above', kind: 'error' })
          },
        })
        return true
      },
    )
  }

  async function push() {
    const publish = !!status && !status.upstream
    const r = await act('push', () => api.git.push(at, publish))
    if (r && status?.branch) toast({ message: publish ? `Published ${status.branch}` : `Pushed ${status.branch}` })
  }

  // Conflicts

  function openConflict(file: string) {
    if (!status) return
    const p = inRepo(status, file)
    if (isMarkdown(file)) notes.open(p)
    else
      api.openFile(profileId, p).then(
        () => toast({ message: `Opened ${splitPath(file).name}` }),
        (err) => toast({ message: message(err), kind: 'error' }),
      )
  }

  async function resolve(file: string, force = false) {
    await act(
      'resolve',
      () => api.git.resolve(at, file, force),
      (err) => {
        if (!err.data.confirm) return false
        setConfirm({
          title: `Mark ${splitPath(file).name} resolved?`,
          action: 'Mark resolved',
          body: 'It still has conflict markers (<<<<<<<, =======, >>>>>>>). Marking it resolved stages it as it is.',
          run: () => {
            setConfirm(null)
            void resolve(file, true)
          },
        })
        return true
      },
    )
  }

  async function askClaude(files: string[]) {
    try {
      chats.open(await api.git.ask(at, files))
    } catch (err) {
      toast({ message: message(err), kind: 'error' })
    }
  }

  // Stash

  function stashMenu(e: React.MouseEvent, s: Stash) {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: 'Pop', icon: <Archive size={14} />, run: () => void stashDo(s, 'pop') },
        { label: 'Apply (keep the stash)', run: () => void stashDo(s, 'apply') },
        'sep',
        {
          label: 'Drop…',
          icon: <Trash2 size={14} />,
          danger: true,
          run: () =>
            setConfirm({
              title: `Drop ${s.message}?`,
              action: 'Drop',
              body: 'Its changes are thrown away.',
              run: () => {
                setConfirm(null)
                void stashDo(s, 'drop')
              },
            }),
        },
      ],
    })
  }

  async function stashDo(s: Stash, action: 'pop' | 'apply' | 'drop') {
    const r = await act(action, () => api.git.stash(at, { action, index: s.index, hash: s.hash }))
    if (r?.conflicts) toast({ message: 'The stash conflicts with your changes; resolve them above (the stash is kept)', kind: 'error' })
    if (sel?.kind === 'stash' && sel.stash.hash === s.hash && action !== 'apply') setSel(null)
  }

  // Keys on a file row: Space stages or unstages it.
  const rowKeys = (e: React.KeyboardEvent, f: GitFile, staged: boolean) => {
    if (e.key === ' ') {
      e.preventDefault()
      void (staged ? unstageFiles([f.path]) : stageFiles([f.path]))
    } else if (e.key === 'Enter') setSel({ kind: 'file', file: f.path, staged })
  }

  if (!status) {
    return <div className="git-view">{error ? <p className="git-empty err">{error}</p> : <p className="git-empty">Reading the repository…</p>}</div>
  }

  const s = status
  const selFile = sel?.kind === 'file' ? sel : null
  const canAmend = !!s.head && !s.headPushed
  const disabled = !!busy

  const fileRow = (f: GitFile, staged: boolean) => {
    const { name, dir } = splitPath(f.path)
    const active = selFile?.file === f.path && selFile.staged === staged
    return (
      <li
        key={`${staged}:${f.path}`}
        className={cx('git-file', active && 'active')}
        role="option"
        aria-selected={active}
        aria-label={f.path}
        tabIndex={0}
        onClick={() => setSel({ kind: 'file', file: f.path, staged })}
        onKeyDown={(e) => rowKeys(e, f, staged)}
      >
        <span className={cx('git-state', `s-${f.state === '?' ? 'new' : f.state}`)} title={STATE_LABEL[f.state]}>
          {f.state === '?' ? 'N' : f.state}
        </span>
        <span className="git-file-name">{name}</span>
        <span className="git-file-dir mono">{f.from ? `${f.from} →` : dir}</span>
        <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
          {!staged && (
            <button className="icon-btn" disabled={disabled} onClick={() => discardFiles([f])} title="Discard changes" aria-label={`Discard ${f.path}`}>
              <Undo2 size={13} />
            </button>
          )}
          {staged ? (
            <button className="icon-btn" disabled={disabled} onClick={() => void unstageFiles([f.path])} title="Unstage" aria-label={`Unstage ${f.path}`}>
              <Minus size={13} />
            </button>
          ) : (
            <button className="icon-btn" disabled={disabled} onClick={() => void stageFiles([f.path])} title="Stage" aria-label={`Stage ${f.path}`}>
              <Plus size={13} />
            </button>
          )}
        </span>
      </li>
    )
  }

  return (
    <div className="git-view">
      <div className="git-split">
        <div className="git-side">
          <div className="git-bar">
            <button className="git-branch" onClick={(e) => void branchMenu(e)} disabled={disabled} aria-label="Branch" title="Switch, create, rename or delete branches">
              <GitBranch size={14} />
              <span className="mono">{s.branch ?? `detached at ${s.head}`}</span>
              <ChevronDown size={12} />
            </button>
            {s.upstream && (
              <span className="git-ab" title={`Compared with ${s.upstream}`}>
                <span className={cx(s.ahead > 0 && 'on')}>↑{s.ahead}</span>
                <span className={cx(s.behind > 0 && 'on')}>↓{s.behind}</span>
              </span>
            )}
            <span className="spacer" />
            {s.remotes.length > 0 && (
              <>
                <button className="icon-btn" disabled={disabled} onClick={() => void act('fetch', () => api.git.fetch(at))} title="Fetch: see what's new on the remote" aria-label="Fetch">
                  <RefreshCw size={13} className={cx(busy === 'fetch' && 'spin')} />
                </button>
                <button className="btn ghost small" disabled={disabled || !s.upstream} onClick={() => void pull()} title={s.upstream ? `Pull from ${s.upstream}` : 'This branch has no upstream'}>
                  <ArrowDown size={13} /> Pull
                </button>
                <button className="btn ghost small" disabled={disabled || !s.branch} onClick={() => void push()} title={s.upstream ? `Push to ${s.upstream}` : `Publish ${s.branch} to ${s.remotes.includes('origin') ? 'origin' : s.remotes[0]}`}>
                  <ArrowUp size={13} /> {s.upstream ? 'Push' : 'Publish'}
                </button>
              </>
            )}
          </div>
          <div className="git-sub">
            <span className="mono">{s.repo}</span>
            {s.sub && <span> · this folder is {s.sub}</span>}
            {s.lastFetch && (
              <span className={cx(s.lastFetch.error && 'err')} title={s.lastFetch.error ?? undefined}>
                {' '}
                · {s.lastFetch.error ? `Last fetch failed: ${s.lastFetch.error.split('\n')[0]}` : `fetched ${ago(s.lastFetch.at)}`}
              </span>
            )}
          </div>

          {s.conflicts.length > 0 && (
            <section className="git-conflicts" role="alert" aria-label="Conflicts">
              <header>
                <GitMerge size={14} />
                <span>
                  {s.operation === 'merge' ? (s.operationLabel ?? 'Merging') : 'Applying a stash'}: conflicts in {s.conflicts.length} {s.conflicts.length === 1 ? 'file' : 'files'}
                </span>
              </header>
              {s.operation === 'stash' && <p>The stash is kept until you drop it.</p>}
              <ul>
                {s.conflicts.map((c) => (
                  <li key={c.path}>
                    <button className="link-btn" onClick={() => setSel({ kind: 'file', file: c.path, staged: false })}>
                      {c.path}
                    </button>
                    <span className="git-conflict-code">{CONFLICT_LABEL[c.code] ?? c.code}</span>
                    <span className="spacer" />
                    <button className="icon-btn" onClick={() => openConflict(c.path)} title={isMarkdown(c.path) ? 'Open as a note' : 'Open in its default app'} aria-label={`Open ${c.path}`}>
                      {isMarkdown(c.path) ? <FileText size={13} /> : <ExternalLink size={13} />}
                    </button>
                    <button className="icon-btn" onClick={() => void askClaude([c.path])} title="Ask claude to resolve it, in a new chat" aria-label={`Ask claude about ${c.path}`}>
                      <MessageSquare size={13} />
                    </button>
                    <button className="btn ghost small" disabled={disabled} onClick={() => void resolve(c.path)}>
                      Mark resolved
                    </button>
                  </li>
                ))}
              </ul>
              <div className="git-conflict-actions">
                {s.conflicts.length > 1 && (
                  <button className="btn ghost small" onClick={() => void askClaude(s.conflicts.map((c) => c.path))}>
                    <MessageSquare size={13} /> Ask claude about all
                  </button>
                )}
                {s.operation === 'merge' && (
                  <button
                    className="btn ghost small danger"
                    disabled={disabled}
                    onClick={() =>
                      setConfirm({
                        title: 'Abort the merge?',
                        action: 'Abort merge',
                        body: 'The branch goes back to how it was before the merge; resolutions so far are lost.',
                        run: () => {
                          setConfirm(null)
                          void act('abort', () => api.git.abort(at))
                        },
                      })
                    }
                  >
                    Abort merge
                  </button>
                )}
              </div>
            </section>
          )}

          <section className="git-section" aria-label="Staged">
            <h3>
              Staged <span className="count">{s.staged.length}</span>
              <span className="spacer" />
              {s.staged.length > 0 && (
                <button className="link-btn" disabled={disabled} onClick={() => void act('unstage', () => api.git.unstage(at, { all: true }))}>
                  Unstage all
                </button>
              )}
            </h3>
            {s.staged.length ? <ul className="git-files" role="listbox" aria-label="Staged files">{s.staged.map((f) => fileRow(f, true))}</ul> : <p className="git-none">Nothing staged.</p>}
          </section>

          <section className="git-section" aria-label="Changes">
            <h3>
              Changes <span className="count">{s.changes.length}</span>
              <span className="spacer" />
              {s.changes.length > 0 && (
                <>
                  <button
                    className="link-btn"
                    disabled={disabled}
                    onClick={() =>
                      setAsk({
                        title: 'Stash changes',
                        label: 'A name for the stash (optional)',
                        initial: '',
                        action: 'Stash',
                        optional: true,
                        run: (m) => void act('stash', () => api.git.stash(at, { action: 'push', message: m || undefined })),
                      })
                    }
                  >
                    Stash…
                  </button>
                  <button className="link-btn" disabled={disabled} onClick={() => discardFiles(s.changes)}>
                    Discard all
                  </button>
                  <button className="link-btn" disabled={disabled} onClick={() => void act('stage', () => api.git.stage(at, { all: true }))}>
                    Stage all
                  </button>
                </>
              )}
            </h3>
            {s.changes.length ? <ul className="git-files" role="listbox" aria-label="Changed files">{s.changes.map((f) => fileRow(f, false))}</ul> : <p className="git-none">No changes.</p>}
          </section>

          <section className="git-commit" aria-label="Commit">
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              placeholder={amend ? 'Message of the amended commit' : 'Commit message (Ctrl+Enter commits)'}
              aria-label="Commit message"
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void commit()
                }
              }}
            />
            <div className="git-commit-bar">
              <button className="btn ghost small" disabled={disabled || !s.staged.length} onClick={() => void draft()} title="Ask claude for a message from the staged changes; you edit it before committing">
                <Sparkles size={13} className={cx(busy === 'draft' && 'pulse')} /> {busy === 'draft' ? 'Drafting…' : 'Draft'}
              </button>
              <label className="check" title={canAmend ? 'Change the last commit instead of making a new one' : s.head ? 'The last commit is already pushed' : 'There is no commit yet'}>
                <input type="checkbox" checked={amend} disabled={!canAmend} onChange={(e) => void toggleAmend(e.target.checked)} /> Amend
              </label>
              <span className="spacer" />
              <button className="btn primary small" disabled={disabled || !msg.trim() || (!amend && !s.staged.length) || s.conflicts.length > 0} onClick={() => void commit()}>
                <GitCommitHorizontal size={13} /> {amend ? 'Amend' : `Commit ${s.staged.length || ''}`.trim()}
              </button>
            </div>
          </section>

          {s.stashes.length > 0 && (
            <section className="git-section" aria-label="Stashes">
              <h3>
                Stashes <span className="count">{s.stashes.length}</span>
              </h3>
              <ul className="git-files">
                {s.stashes.map((st) => (
                  <li
                    key={st.hash}
                    className={cx('git-file', sel?.kind === 'stash' && sel.stash.hash === st.hash && 'active')}
                    tabIndex={0}
                    aria-label={st.message}
                    onClick={() => setSel({ kind: 'stash', stash: st })}
                    onContextMenu={(e) => stashMenu(e, st)}
                  >
                    <Archive size={13} className="icon" />
                    <span className="git-file-name">{st.message}</span>
                    <span className="git-file-dir">{ago(st.at * 1000)}</span>
                    <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn ghost small" disabled={disabled} onClick={() => void stashDo(st, 'pop')}>
                        Pop
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="git-section" aria-label="History">
            <h3>History</h3>
            {history === null ? (
              <p className="git-none">Reading…</p>
            ) : history.length === 0 ? (
              <p className="git-none">No commits yet.</p>
            ) : (
              <ul className="git-log">
                {history.map((c) => (
                  <li
                    key={c.hash}
                    className={cx('git-commit-row', sel?.kind === 'commit' && sel.hash === c.hash && 'active')}
                    tabIndex={0}
                    aria-label={c.subject}
                    onClick={() => setSel({ kind: 'commit', hash: c.hash })}
                    onKeyDown={(e) => e.key === 'Enter' && setSel({ kind: 'commit', hash: c.hash })}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        entries: [
                          {
                            label: 'Copy hash',
                            icon: <Copy size={14} />,
                            run: () => void navigator.clipboard.writeText(c.hash).then(() => toast({ message: `Copied ${c.short}` }), () => toast({ message: 'Could not copy', kind: 'error' })),
                          },
                        ],
                      })
                    }}
                  >
                    <span className="git-subject">{c.subject}</span>
                    <span className="git-meta">
                      <span className="mono">{c.short}</span> · {c.author} · {ago(c.at * 1000)}
                    </span>
                  </li>
                ))}
                {more && (
                  <li className="git-more">
                    <button
                      className="link-btn"
                      onClick={() =>
                        void api.git.log(at, history.length).then((next) => {
                          setHistory((h) => [...(h ?? []), ...next])
                          setMore(next.length === 200)
                        })
                      }
                    >
                      Load more
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        </div>

        <div className="git-detail" aria-label="Details">
          {!sel ? (
            <p className="git-empty">Pick a file to see its changes, or a commit to see what it did.</p>
          ) : sel.kind === 'file' ? (
            <FileDiff
              key={`${sel.staged}:${sel.file}`}
              at={at}
              sel={sel}
              tick={tick}
              status={s}
              disabled={disabled}
              onHunk={hunkAction}
              onStage={(staged) => void (staged ? unstageFiles([sel.file]) : stageFiles([sel.file]))}
              onDiscard={() => {
                const f = s.changes.find((c) => c.path === sel.file)
                if (f) discardFiles([f])
              }}
              onGone={(staged) => setSel((cur) => (cur?.kind === 'file' && cur.file === sel.file && cur.staged === staged ? null : cur))}
            />
          ) : sel.kind === 'commit' ? (
            <CommitView key={sel.hash} at={at} hash={sel.hash} title={null} />
          ) : (
            <CommitView key={sel.stash.hash} at={at} hash={sel.stash.hash} title={sel.stash.message} />
          )}
        </div>
      </div>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {confirm && (
        <ConfirmDialog title={confirm.title} action={confirm.action} onCancel={() => setConfirm(null)} onConfirm={confirm.run}>
          {confirm.body}
        </ConfirmDialog>
      )}
      {choice && <ChoiceDialog choice={choice} onClose={() => setChoice(null)} />}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
    </div>
  )
}

/** The selected file's diff; read again whenever the status is. */
function FileDiff(props: {
  at: { profile: string; path: string }
  sel: { file: string; staged: boolean }
  tick: number
  status: GitStatus
  disabled: boolean
  onHunk: (file: string, hunk: Hunk, how: 'stage' | 'unstage' | 'discard') => void
  onStage: (staged: boolean) => void
  onDiscard: () => void
  onGone: (staged: boolean) => void
}) {
  const { at, sel, tick, status, disabled } = props
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const conflict = status.conflicts.some((c) => c.path === sel.file)
  const listed = conflict || (sel.staged ? status.staged : status.changes).some((f) => f.path === sel.file)

  useEffect(() => {
    if (!listed) return props.onGone(sel.staged)
    let on = true
    api.git.diff(at, sel.file, sel.staged).then(
      (d) => {
        if (!on) return
        setDiff((cur) => (JSON.stringify(cur) === JSON.stringify(d) ? cur : d))
        setError(null)
      },
      (err) => on && setError(message(err)),
    )
    return () => {
      on = false
    }
  }, [at, sel.file, sel.staged, tick, listed])

  const { name, dir } = splitPath(sel.file)
  return (
    <div className="git-file-diff">
      <div className="git-detail-head">
        <div>
          <strong>{name}</strong> <span className="mono muted">{diff?.from ? `${diff.from} → ` : dir}</span>
          <div className="muted small">{conflict ? 'Conflict: your version against HEAD' : sel.staged ? 'Staged' : diff?.untracked ? 'New file' : 'Changes not staged'}</div>
        </div>
        {!conflict && (
          <div className="git-detail-actions">
            {!sel.staged && (
              <button className="btn ghost small" disabled={disabled} onClick={props.onDiscard}>
                <Undo2 size={13} /> Discard file
              </button>
            )}
            <button className="btn ghost small" disabled={disabled} onClick={() => props.onStage(sel.staged)}>
              {sel.staged ? <Minus size={13} /> : <Plus size={13} />} {sel.staged ? 'Unstage file' : 'Stage file'}
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p className="git-empty err">{error}</p>
      ) : !diff ? (
        <p className="git-empty">Reading…</p>
      ) : (
        <GitDiff
          diff={diff}
          actions={
            conflict || diff.untracked
              ? undefined
              : (h) =>
                  sel.staged ? (
                    <button className="btn ghost small" disabled={disabled} onClick={() => props.onHunk(sel.file, h, 'unstage')}>
                      Unstage hunk
                    </button>
                  ) : (
                    <>
                      <button className="btn ghost small" disabled={disabled} onClick={() => props.onHunk(sel.file, h, 'discard')}>
                        Discard hunk
                      </button>
                      <button className="btn ghost small" disabled={disabled} onClick={() => props.onHunk(sel.file, h, 'stage')}>
                        Stage hunk
                      </button>
                    </>
                  )
          }
        />
      )}
    </div>
  )
}

/** A commit (or a stash, which is one): its message, who and when, and its files with their diffs. */
function CommitView({ at, hash, title }: { at: { profile: string; path: string }; hash: string; title: string | null }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.git.commitDetail(at, hash).then(
      (d) => {
        setDetail(d)
        setFile(d.files[0]?.path ?? null)
      },
      (err) => setError(message(err)),
    )
  }, [at, hash])

  useEffect(() => {
    setDiff(null)
    if (file) api.git.commitDiff(at, hash, file).then(setDiff, (err) => setError(message(err)))
  }, [at, hash, file])

  if (error) return <p className="git-empty err">{error}</p>
  if (!detail) return <p className="git-empty">Reading…</p>
  return (
    <div className="git-commit-view">
      <div className="git-detail-head">
        <div>
          <strong>{title ?? detail.subject}</strong>
          <div className="muted small">
            <span className="mono">{detail.short}</span> · {detail.author} &lt;{detail.email}&gt; · {new Date(detail.at * 1000).toLocaleString()}
            {detail.parents.length > 1 && ` · merge of ${detail.parents.map((p) => p.slice(0, 7)).join(' and ')}, shown against the first`}
          </div>
        </div>
      </div>
      {!title && detail.body && <pre className="git-body">{detail.body}</pre>}
      <ul className="git-commit-files" aria-label="Changed files">
        {detail.files.map((f) => (
          <li key={f.path} className={cx(file === f.path && 'active')} onClick={() => setFile(f.path)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setFile(f.path)}>
            <span className={cx('git-state', `s-${f.state}`)} title={STATE_LABEL[f.state]}>
              {f.state}
            </span>
            <span className="git-file-name">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
            <span className="git-numstat mono">
              {f.added === null ? 'binary' : (
                <>
                  <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {diff && <GitDiff diff={diff} />}
    </div>
  )
}

function ChoiceDialog({ choice, onClose }: { choice: Choice; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog confirm" role="alertdialog" aria-label={choice.title}>
        <header>{choice.title}</header>
        <div className="body">
          <p>{choice.body}</p>
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {choice.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className={cx('btn', o.primary ? 'primary' : 'ghost')}
              autoFocus={o.primary}
              onClick={() => {
                onClose()
                o.run()
              }}
            >
              {o.label}
            </button>
          ))}
        </footer>
      </div>
    </div>
  )
}

function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [value, setValue] = useState(ask.initial)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-label={ask.title}
        onSubmit={(e) => {
          e.preventDefault()
          if (!value.trim() && !ask.optional) return
          onClose()
          ask.run(value.trim())
        }}
      >
        <header>{ask.title}</header>
        <div className="body">
          <label className="field">
            <span>{ask.label}</span>
            <input className="mono" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </label>
        </div>
        <footer>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim() && !ask.optional}>
            {ask.action}
          </button>
        </footer>
      </form>
    </div>
  )
}
