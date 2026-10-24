// The agent profile editor: the profile's `agents:` on the left, one agent
// profile's settings on the right. Saves go through the setAgent op, so the
// YAML keeps its comments and the toast can undo them.
import { Plus, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  AGENT_NAME,
  AGENT_NAME_RULE,
  agentSummary,
  EFFORTS,
  isReservedAgent,
  PERMISSION_MODES,
  type AgentProfile,
  type Op,
  type PermissionMode,
  type Profile,
} from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'

const PERMISSION_TEXT: Record<PermissionMode, string> = {
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan (read only)',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

/** The list's entry for a profile not saved yet. */
const NEW = ''

interface Props {
  profile: Profile
  profileId: string
  /** A folder of the profile, whose `.claude/agents` adds to the Claude agent suggestions. */
  folder: string
  run: (ops: Op[], undoLabel?: string) => Promise<boolean>
  onClose: () => void
}

export function AgentProfilesDialog({ profile, profileId, folder, run, onClose }: Props) {
  const names = Object.keys(profile.agents ?? {})
  const [selected, setSelected] = useState<string>(names[0] ?? NEW)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const current = selected !== NEW && profile.agents?.[selected] ? selected : NEW

  useEffect(() => {
    let live = true
    api.claudeAgents(profileId, folder).then(
      (s) => live && setSuggestions(s),
      () => live && setSuggestions([]),
    )
    return () => {
      live = false
    }
  }, [profileId, folder])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog agents-dialog" role="dialog" aria-label="Agent profiles">
        <header>
          Agent profiles
          <small>{profile.name} · how claude starts when you pick one for a chat</small>
        </header>
        <div className="agents-body">
          <div className="agents-list" role="listbox" aria-label="Agent profiles">
            {names.map((n) => {
              const a = profile.agents![n]
              return (
                <button key={n} role="option" aria-selected={current === n} className={cx(current === n && 'active')} onClick={() => setSelected(n)}>
                  {a.permission === 'bypassPermissions' ? <ShieldAlert size={14} className="icon bypass-mark" /> : <Sparkles size={14} className="icon" />}
                  <span className="name">{n}</span>
                  <span className="summary">{agentSummary(a)}</span>
                </button>
              )
            })}
            <button role="option" aria-selected={current === NEW} className={cx('add', current === NEW && 'active')} onClick={() => setSelected(NEW)}>
              <Plus size={14} className="icon" />
              <span className="name">New agent profile</span>
            </button>
          </div>
          <AgentForm
            key={current}
            name={current === NEW ? null : current}
            agent={current === NEW ? null : profile.agents![current]}
            taken={names}
            suggestions={suggestions}
            run={run}
            onDone={(n) => setSelected(n ?? NEW)}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  )
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

function AgentForm({
  name,
  agent,
  taken,
  suggestions,
  run,
  onDone,
  onClose,
}: {
  name: string | null
  agent: AgentProfile | null
  taken: string[]
  suggestions: string[]
  run: Props['run']
  /** After a save (the profile's name) or a delete (null). */
  onDone: (name: string | null) => void
  onClose: () => void
}) {
  const [form, setForm] = useState(() => ({
    name: name ?? '',
    agent: agent?.agent ?? '',
    model: agent?.model ?? '',
    effort: agent?.effort ?? '',
    permission: agent?.permission ?? '',
    instructions: agent?.instructions ?? '',
    prompt: agent?.prompt ?? '',
    folders: (agent?.folders ?? []).join('\n'),
    allowedTools: (agent?.allowedTools ?? []).join('\n'),
    disallowedTools: (agent?.disallowedTools ?? []).join('\n'),
    mcp: agent?.mcp ?? '',
  }))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = (key: keyof typeof form) => ({
    name: key,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  })
  const byAgent = !!form.agent.trim()

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const n = form.name.trim()
    if (isReservedAgent(n)) return setError('claude and shell are built in; pick another name')
    if (!AGENT_NAME.test(n)) return setError(AGENT_NAME_RULE)
    if (taken.some((t) => t !== name && t.toLowerCase() === n.toLowerCase())) return setError(`There is already an agent profile named ${n}`)
    setError(null)
    const data = {
      agent: form.agent,
      model: form.model,
      effort: (form.effort || undefined) as AgentProfile['effort'],
      permission: (form.permission || undefined) as AgentProfile['permission'],
      instructions: form.instructions,
      prompt: form.prompt,
      folders: lines(form.folders),
      allowedTools: lines(form.allowedTools),
      disallowedTools: lines(form.disallowedTools),
      mcp: form.mcp,
    }
    setBusy(true)
    const op: Op = { op: 'setAgent', name: name ?? n, agent: data, rename: name && n !== name ? n : undefined }
    const ok = await run([op], name ? `Saved ${n}` : `Added agent profile ${n}`)
    setBusy(false)
    if (ok) onDone(n)
  }

  async function remove() {
    if (!name) return
    setBusy(true)
    const ok = await run([{ op: 'setAgent', name, agent: null }], `Deleted agent profile ${name}`)
    setBusy(false)
    if (ok) onDone(null)
  }

  return (
    <form className="agent-form" onSubmit={save} aria-label={name ? `Agent profile ${name}` : 'New agent profile'}>
      <div className="agent-fields">
        <label className="field">
          <span>Name</span>
          <input {...field('name')} autoFocus={!name} placeholder="Reviewer" />
          {error ? <span className="err">{error}</span> : <span className="hint">Chat steps, chat entries and items use it by this name.</span>}
        </label>
        <label className="field">
          <span>Claude agent (optional)</span>
          <input className="mono" {...field('agent')} list="claude-agent-names" placeholder="orchestrator" />
          <datalist id="claude-agent-names">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <span className="hint">One of your Claude Code agents (~/.claude/agents or the folder's .claude/agents), e.g. an orchestrator.</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Model</span>
            <input className="mono" {...field('model')} list="claude-models" placeholder={byAgent ? 'Left to the agent' : "claude's default"} disabled={byAgent} />
            <datalist id="claude-models">
              <option value="opus" />
              <option value="sonnet" />
              <option value="haiku" />
            </datalist>
          </label>
          <label className="field">
            <span>Effort</span>
            <select {...field('effort')} disabled={byAgent}>
              <option value="">{byAgent ? 'Left to the agent' : "claude's default"}</option>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Permissions</span>
            <select {...field('permission')}>
              <option value="">Ask (claude's default)</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_TEXT[m]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {form.permission === 'bypassPermissions' && (
          <p className="warn-line" role="alert">
            <ShieldAlert size={14} />
            Claude will run every tool without asking, including shell commands and edits outside the project. Chats with this profile show a shield.
          </p>
        )}
        <label className="field">
          <span>Instructions</span>
          <textarea {...field('instructions')} rows={4} placeholder="You review code. Don't edit files." />
          <span className="hint">Added to claude's system prompt.</span>
        </label>
        <label className="field">
          <span>First prompt (optional)</span>
          <textarea {...field('prompt')} rows={2} placeholder="Review the latest changes" />
          <span className="hint">Sent when a new session starts, not when one resumes.</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Extra folders</span>
            <textarea className="mono" {...field('folders')} rows={3} placeholder="~/Projects/shared-assets" />
          </label>
          <label className="field">
            <span>Allowed tools</span>
            <textarea className="mono" {...field('allowedTools')} rows={3} placeholder={'Read\nBash(git:*)'} />
          </label>
          <label className="field">
            <span>Blocked tools</span>
            <textarea className="mono" {...field('disallowedTools')} rows={3} placeholder="WebFetch" />
          </label>
        </div>
        <span className="hint">One per line. Relative folders are inside the chat's folder.</span>
        <label className="field">
          <span>MCP config file (optional)</span>
          <input className="mono" {...field('mcp')} placeholder="~/mcp/review.json" />
        </label>
      </div>
      <footer>
        {name && (
          <button type="button" className="btn ghost danger-text" onClick={() => void remove()} disabled={busy}>
            <Trash2 size={14} /> Delete
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onClose}>
          Close
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          {name ? 'Save' : 'Add'}
        </button>
      </footer>
    </form>
  )
}
