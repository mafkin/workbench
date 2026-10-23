// What claude loads, everywhere or in one folder: skills, MCP servers, agents,
// commands, hooks and plugins, each with the scope it comes from. Read-only,
// except that MCP servers switch on and off (in a folder like /mcp; everywhere,
// as the profile's defaults); the service masks secrets before they get here.
// MCP servers can be checked on demand. The Claude setup page (sidebar) and a
// project's Claude setup tab both show this; it is a lazy chunk of its own.
import type { LucideIcon } from 'lucide-react'
import { Blocks, Bot, CircleCheck, CircleX, LoaderCircle, Plug, Puzzle, RefreshCw, Search, Sparkles, SquareSlash, TriangleAlert, Webhook, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SCOPE_LABEL, type ClaudeSetup, type HookEntry, type McpCheck, type McpEntry, type McpState, type PluginEntry, type SetupDoc, type SetupScope } from '../../shared/claude-setup.ts'
import { drawersOf, type Profile } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { useLocal } from '../lib/local.ts'
import { cx } from '../lib/nav.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import type { ToastInput } from './Toast.tsx'

type SectionId = 'skills' | 'mcp' | 'agents' | 'commands' | 'hooks' | 'plugins'

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon; empty: string }[] = [
  { id: 'skills', label: 'Skills', icon: Sparkles, empty: 'No skills. Yours go in ~/.claude/skills/<name>/SKILL.md, a project’s in .claude/skills/.' },
  { id: 'mcp', label: 'MCP servers', icon: Plug, empty: 'No MCP servers. Add one with claude mcp add, or in a project’s .mcp.json.' },
  { id: 'agents', label: 'Agents', icon: Bot, empty: 'No agents. Yours go in ~/.claude/agents/, a project’s in .claude/agents/.' },
  { id: 'commands', label: 'Commands', icon: SquareSlash, empty: 'No commands. Yours go in ~/.claude/commands/, a project’s in .claude/commands/.' },
  { id: 'hooks', label: 'Hooks', icon: Webhook, empty: 'No hooks. They go under "hooks" in a settings.json.' },
  { id: 'plugins', label: 'Plugins', icon: Puzzle, empty: 'No plugins. Add them in claude with /plugin.' },
]

const STATE_LABEL: Record<McpState, string> = { on: 'On', off: 'Off', pending: 'Not approved', blocked: 'Blocked', overridden: 'Overridden', broken: 'Broken' }
const SCOPE_RANK: Record<SetupScope, number> = { project: 0, local: 1, user: 2, managed: 3, plugin: 4 }
/** What a switch shows: on unless turned off (a server waiting for approval is not off). */
const switchedOn = (m: McpEntry) => m.state === 'on' || m.state === 'pending'

type Item = { kind: 'doc'; v: SetupDoc } | { kind: 'mcp'; v: McpEntry } | { kind: 'hook'; v: HookEntry } | { kind: 'plugin'; v: PluginEntry }

interface Row {
  id: string
  title: string
  sub: string
  scope?: SetupScope
  plugin?: string
  dim: boolean
  /** A small word after the name: overridden, synced, on or off. */
  flag?: string
  tone?: 'ok' | 'warn' | 'bad'
  item: Item
}

function rowsOf(setup: ClaudeSetup, section: SectionId): Row[] {
  const docRow = (d: SetupDoc): Row => ({
    id: d.id,
    title: d.kind === 'agent' ? d.name : `/${d.name}`,
    sub: d.description,
    scope: d.scope,
    plugin: d.plugin,
    dim: !!d.overriddenBy,
    flag: d.overriddenBy ? 'overridden' : d.synced ? 'synced' : undefined,
    item: { kind: 'doc', v: d },
  })
  let rows: Row[]
  if (section === 'skills' || section === 'agents' || section === 'commands') rows = setup[section].map(docRow)
  else if (section === 'mcp') {
    rows = setup.mcp.map((m) => ({
      id: m.id,
      title: m.name,
      sub: m.transport === 'stdio' ? [m.command, ...(m.args ?? [])].join(' ') : (m.url ?? ''),
      scope: m.scope,
      plugin: m.plugin,
      dim: m.state !== 'on' && m.state !== 'pending',
      flag: m.state === 'on' ? undefined : STATE_LABEL[m.state].toLowerCase(),
      tone: m.state === 'pending' ? 'warn' : m.state === 'blocked' || m.state === 'broken' ? 'bad' : undefined,
      item: { kind: 'mcp', v: m },
    }))
  } else if (section === 'hooks') {
    rows = setup.hooks.map((h) => ({
      id: h.id,
      title: h.matcher ? `${h.event} · ${h.matcher}` : h.event,
      sub: h.run,
      scope: h.scope,
      plugin: h.plugin,
      dim: !!h.off,
      flag: h.off ? 'off' : undefined,
      item: { kind: 'hook', v: h },
    }))
  } else {
    return setup.plugins
      .map((p): Row => ({ id: p.id, title: p.name, sub: p.description ?? p.id, plugin: p.name, dim: !p.enabled, flag: p.enabled ? 'on' : 'off', tone: p.enabled ? 'ok' : undefined, item: { kind: 'plugin', v: p } }))
      .sort((a, b) => Number(b.flag === 'on') - Number(a.flag === 'on') || a.title.localeCompare(b.title))
  }
  return rows.sort((a, b) => SCOPE_RANK[a.scope!] - SCOPE_RANK[b.scope!] || (a.plugin ?? '').localeCompare(b.plugin ?? '') || a.title.localeCompare(b.title))
}

// Check results stay for this window (until a reload), whichever view shows them.
type CheckState = McpCheck | 'running'
const checks = new Map<string, CheckState>()
const listeners = new Set<() => void>()
let checksVersion = 0
function setCheck(key: string, value: CheckState) {
  checks.set(key, value)
  checksVersion++
  for (const l of listeners) l()
}
const useChecks = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => checksVersion,
  )

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Props {
  profileId: string
  profile: Profile
  /** The folder whose setup shows: a project's tab, or the drawer's own folder; none = what claude loads everywhere. */
  folder?: string
  /** The drawer whose MCP defaults the switches show and set (the rail); the project's own drawer when left out. */
  drawer?: number
  /** Only these kinds (the rail's Skills or MCP view); one kind hides the kind tabs. */
  kinds?: SectionId[]
  /** The profile's rev, for switching a drawer's defaults. */
  rev?: string
  toast?: (t: ToastInput) => void
}

export default function ClaudeSetupView({ profileId, profile, folder: fixed, drawer, kinds, rev, toast }: Props) {
  const folder = fixed ?? null
  const shown = useMemo(() => SECTIONS.filter((s) => !kinds || kinds.includes(s.id)), [kinds])
  const [savedSection, setSection] = useLocal<SectionId>('setupSection', 'skills')
  const section = shown.some((s) => s.id === savedSection) ? savedSection : shown[0].id
  const drawerName = drawersOf(profile)[drawer ?? 0]?.name ?? profile.name
  const [setup, setSetup] = useState<ClaudeSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [filter, setFilter] = useState('')
  const [pluginFilter, setPluginFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<McpEntry | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [showOff, setShowOff] = useState(false)
  const [switching, setSwitching] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  // An Undo runs later, after the switch itself changed the rev.
  const revRef = useRef(rev)
  revRef.current = rev
  useChecks()

  useEffect(() => {
    let live = true
    setError(null)
    api.claudeSetup(profileId, folder, drawer).then(
      (s) => live && setSetup(s),
      (err) => live && (setError(message(err)), setSetup(null)),
    )
    return () => {
      live = false
    }
  }, [profileId, folder, drawer, tick])

  const all = useMemo(() => (setup ? rowsOf(setup, section) : []), [setup, section])
  const matching = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return all.filter((r) => (!pluginFilter || r.plugin === pluginFilter) && (!q || `${r.title} ${r.sub} ${r.plugin ?? ''}`.toLowerCase().includes(q)))
  }, [all, filter, pluginFilter])
  // MCP servers that are off fold away, unless shown or looked for.
  const isOff = (r: Row) => r.item.kind === 'mcp' && r.item.v.state === 'off'
  const folding = section === 'mcp' && !filter.trim() && !pluginFilter
  const offCount = folding ? matching.filter(isOff).length : 0
  const rows = folding && !showOff ? matching.filter((r) => !isOff(r)) : matching
  const current = rows.find((r) => r.id === selected) ?? rows[0] ?? null
  const checkKey = (id: string) => `${profileId}|${folder ?? ''}|${id}`
  const meta = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  const showSection = (id: SectionId, plugin: string | null = null) => {
    if (!shown.some((s) => s.id === id)) return
    setSection(id)
    setPluginFilter(plugin)
    setFilter('')
    setSelected(null)
  }

  async function runCheck(m: McpEntry, confirmed = false) {
    const key = checkKey(m.id)
    setCheck(key, 'running')
    try {
      setCheck(key, await api.checkMcp(profileId, folder, m.id, confirmed))
    } catch (err) {
      setCheck(key, { ok: false, ms: 0, tools: [], error: message(err) })
    }
  }
  const check = (m: McpEntry) => (m.confirm ? setConfirming(m) : void runCheck(m))

  async function switchMcp(servers: McpEntry[], on: boolean, undoable = true) {
    const keys = [...new Set(servers.map((m) => m.key))]
    if (!keys.length) return
    setSwitching(true)
    try {
      const r = await api.switchMcp(profileId, folder, keys, on, revRef.current, drawer)
      if (r.rev) revRef.current = r.rev
      setSetup(r.setup)
      const what = servers.length === 1 ? servers[0].name : `${keys.length} servers`
      const where = folder ? 'here' : `by default in the ${drawerName} drawer`
      toast?.({
        message: `${what} ${on ? 'on' : 'off'} ${where}. New chats use this.`,
        ...(undoable ? { action: { label: 'Undo', run: () => void switchMcp(servers, !on, false) } } : {}),
      })
    } catch (err) {
      toast?.({ message: message(err), kind: 'error' })
    } finally {
      setSwitching(false)
    }
  }

  async function checkAll() {
    if (!setup) return
    // Servers waiting for approval each ask first, so Check all leaves them out.
    const todo = setup.mcp.filter((m) => !m.uncheckable && !m.confirm)
    let next = 0
    const worker = async () => {
      while (next < todo.length) await runCheck(todo[next++])
    }
    setCheckingAll(true)
    await Promise.all([worker(), worker(), worker()])
    setCheckingAll(false)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = current ? rows.indexOf(current) : -1
    const to = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!to) return
    setSelected(to.id)
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(to.id)}"]`)?.focus()
  }

  const body = (
    <div className="setup">
      <div className="setup-toolbar">
        {fixed ? (
          <span className="setup-for">
            What applies in <span className="mono">{fixed}</span>: this folder, local, yours, managed and plugins
          </span>
        ) : (
          <span className="setup-for">
            What claude loads everywhere (yours, managed and plugins); the switches are the {drawerName} drawer's defaults
          </span>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setTick((t) => t + 1)} title="Read claude’s files again">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {error && (
        <div className="setup-problems" role="alert">
          <TriangleAlert size={14} /> {error}
        </div>
      )}
      {setup && setup.problems.length > 0 && (
        <details className="setup-problems">
          <summary>
            <TriangleAlert size={14} /> {setup.problems.length === 1 ? 'A file' : `${setup.problems.length} files`} could not be read fully
          </summary>
          <ul>
            {setup.problems.map((p, i) => (
              <li key={i}>
                <span className="mono">{p.path}</span>: {p.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className={cx('setup-sections', shown.length === 1 && 'lone')} role="tablist" aria-label="Kinds">
        {shown.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id} className={cx('setup-section', section === s.id && 'active')} onClick={() => showSection(s.id)}>
            <s.icon size={13} className="icon" />
            {s.label}
            <span className="count">{setup ? setup[s.id].length : '·'}</span>
          </button>
        ))}
      </div>

      <div className="setup-split">
        <div className="setup-list-pane">
          <div className="setup-filter">
            <label className="filter-box">
              <Search size={13} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter" />
            </label>
            {pluginFilter && (
              <button className="chip on" onClick={() => setPluginFilter(null)} title="Show all">
                Plugin: {pluginFilter} <X size={11} />
              </button>
            )}
            {section === 'mcp' && setup && setup.mcp.length > 0 && (
              <button className="btn" onClick={() => void checkAll()} disabled={checkingAll} title="Check every server that is on; ones waiting for approval ask one by one">
                {checkingAll ? <LoaderCircle size={13} className="spin" /> : <Plug size={13} />} Check all
              </button>
            )}
          </div>
          {section === 'mcp' && setup && setup.mcp.length > 0 && (
            <p className="setup-switch-hint">
              {folder
                ? 'Switches work like /mcp in this folder.'
                : `Switches set the ${drawerName} drawer’s defaults: off now in each of its projects, and in other folders before their first chat.`}{' '}
              Running chats keep their servers until they restart.
            </p>
          )}
          {!setup && !error ? (
            <p className="setup-empty">Reading claude’s files…</p>
          ) : rows.length === 0 ? (
            <p className="setup-empty">{all.length ? 'Nothing matches.' : meta.empty}</p>
          ) : (
            <ul className="setup-list" role="listbox" aria-label={meta.label} ref={listRef} onKeyDown={onListKey}>
              {rows.map((r) => {
                const result = r.item.kind === 'mcp' ? checks.get(checkKey(r.id)) : undefined
                return (
                  <li
                    key={r.id}
                    data-id={r.id}
                    role="option"
                    tabIndex={0}
                    aria-selected={current?.id === r.id}
                    className={cx('setup-row', current?.id === r.id && 'active', r.dim && 'dim')}
                    onClick={() => setSelected(r.id)}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(r.id)}
                  >
                    <span className="setup-row-head">
                      {result && <CheckDot result={result} />}
                      <span className={cx('setup-row-title', r.item.kind !== 'plugin' && r.item.kind !== 'hook' && 'mono')}>{r.title}</span>
                      {r.flag && <span className={cx('setup-flag', r.tone)}>{r.flag}</span>}
                      <span className="spacer" />
                      {r.scope && <ScopeBadge scope={r.scope} plugin={r.plugin} />}
                      {r.item.kind === 'mcp' && <McpSwitch entry={r.item.v} busy={switching} onSwitch={(m, on) => void switchMcp([m], on)} />}
                    </span>
                    {r.sub && <span className={cx('setup-row-sub', (r.item.kind === 'mcp' || r.item.kind === 'hook') && 'mono')}>{r.sub}</span>}
                  </li>
                )
              })}
            </ul>
          )}
          {offCount > 0 && (
            <button className="setup-fold" onClick={() => setShowOff((v) => !v)} aria-expanded={showOff}>
              {offCount} off · {showOff ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
        <div className="setup-detail" aria-label="Details">
          {current?.item.kind === 'doc' ? (
            <DocDetail key={current.id} doc={current.item.v} profileId={profileId} folder={folder} />
          ) : current?.item.kind === 'mcp' ? (
            <McpDetail entry={current.item.v} result={checks.get(checkKey(current.id))} onCheck={check} busy={switching} onSwitch={(m, on) => void switchMcp([m], on)} />
          ) : current?.item.kind === 'hook' ? (
            <HookDetail hook={current.item.v} />
          ) : current?.item.kind === 'plugin' ? (
            <PluginDetail
              plugin={current.item.v}
              onShow={showSection}
              servers={setup?.mcp.filter((m) => m.plugin === current.title) ?? []}
              busy={switching}
              onSwitch={(ms, on) => void switchMcp(ms, on)}
            />
          ) : null}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Check a server claude has not approved"
          action="Check"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const m = confirming
            setConfirming(null)
            void runCheck(m, true)
          }}
        >
          Checking runs <span className="mono">{[confirming.command, ...(confirming.args ?? [])].join(' ') || confirming.url}</span> from {confirming.path} on your machine. claude asks
          before it starts this one; check it only if you trust this folder.
        </ConfirmDialog>
      )}
    </div>
  )

  // A project's tab and the rail's views bring their own frame.
  if (fixed || kinds) return body
  return (
    <div className="page setup-page">
      <div className="page-kicker">Claude</div>
      <h1 className="page-title">
        <Blocks size={22} className="icon" /> Claude setup
      </h1>
      <p className="page-sub">What claude loads on this machine. MCP servers switch on and off here; change the rest in claude or in its files. Secret values are hidden.</p>
      {body}
    </div>
  )
}

function ScopeBadge({ scope, plugin }: { scope: SetupScope; plugin?: string }) {
  return (
    <span className={cx('scope-badge', `scope-${scope}`)} title={scope === 'plugin' ? `From the plugin ${plugin}` : `Scope: ${SCOPE_LABEL[scope]}`}>
      {scope === 'plugin' ? plugin : SCOPE_LABEL[scope]}
    </span>
  )
}

/** On or off for new chats; a server claude won't start anyway (blocked, broken, overridden) can't be switched. */
function McpSwitch({ entry: m, busy, onSwitch }: { entry: McpEntry; busy: boolean; onSwitch: (m: McpEntry, on: boolean) => void }) {
  const on = switchedOn(m)
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={`${m.name} on`}
      className={cx('switch', on && 'on')}
      disabled={busy || !!m.fixed}
      title={m.fixed ?? (on ? 'Turn off' : 'Turn on')}
      onClick={(e) => {
        e.stopPropagation()
        onSwitch(m, !on)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}

function CheckDot({ result }: { result: CheckState }) {
  if (result === 'running') return <LoaderCircle size={12} className="spin check-icon" aria-label="Checking" />
  const kind = result.ok ? 'ok' : result.needsAuth ? 'warn' : 'bad'
  return <span className={cx('check-dot', kind)} aria-label={result.ok ? 'Answered' : result.needsAuth ? 'Needs sign-in' : 'Failed'} />
}

// Links to the web open in a new tab; others (relative files) and images show as text.
const MD: Components = {
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span className="setup-link">{children}</span>
    ),
  img: ({ alt }) => <span className="img-missing">{alt || 'Image'}</span>,
}

function DocDetail({ doc, profileId, folder }: { doc: SetupDoc; profileId: string; folder: string | null }) {
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.claudeDoc(profileId, folder, doc.id).then(
      (r) => live && setBody(r.body),
      (err) => live && setError(message(err)),
    )
    return () => {
      live = false
    }
  }, [profileId, folder, doc.id])

  const word = doc.kind === 'agent' ? 'Agent' : doc.kind === 'skill' ? 'Skill' : 'Command'
  return (
    <>
      <div className="setup-detail-head">
        <span className="page-kicker">{word}</span>
        <h2 className="mono">{doc.kind === 'agent' ? doc.name : `/${doc.name}`}</h2>
        <ScopeBadge scope={doc.scope} plugin={doc.plugin} />
      </div>
      {doc.description && <p className="setup-desc">{doc.description}</p>}
      {doc.overriddenBy && <p className="setup-note">Overridden: claude uses {doc.overriddenBy} instead.</p>}
      <dl className="setup-meta">
        <dt>File</dt>
        <dd className="mono">{doc.path}</dd>
        {doc.synced && (
          <>
            <dt>From</dt>
            <dd>Synced from claude.ai</dd>
          </>
        )}
        {doc.fields.map(([k, v]) => (
          <Field key={k} label={k} value={v} />
        ))}
      </dl>
      <div className="markdown setup-body">
        {error ? (
          <p className="err">{error}</p>
        ) : body === null ? (
          <p className="setup-empty">Loading…</p>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
            {body}
          </ReactMarkdown>
        )}
      </div>
    </>
  )
}

function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </>
  )
}

interface McpDetailProps {
  entry: McpEntry
  result: CheckState | undefined
  onCheck: (m: McpEntry) => void
  busy: boolean
  onSwitch: (m: McpEntry, on: boolean) => void
}

function McpDetail({ entry: m, result, onCheck, busy, onSwitch }: McpDetailProps) {
  return (
    <>
      <div className="setup-detail-head">
        <span className="page-kicker">MCP server · {m.transport}</span>
        <h2 className="mono">{m.name}</h2>
        <ScopeBadge scope={m.scope} plugin={m.plugin} />
        <span className={cx('state-pill', `state-${m.state}`)}>{STATE_LABEL[m.state]}</span>
        <span className="spacer" />
        <McpSwitch entry={m} busy={busy} onSwitch={onSwitch} />
      </div>
      {m.note && <p className="setup-note">{m.note}</p>}
      <dl className="setup-meta">
        {m.command !== undefined && <Field label="Command" value={[m.command, ...(m.args ?? [])].join(' ')} />}
        {m.url !== undefined && <Field label="URL" value={m.url} />}
        {m.env.length > 0 && (
          <>
            <dt>Env</dt>
            <dd>
              <KeyValues pairs={m.env} />
            </dd>
          </>
        )}
        {m.headers.length > 0 && (
          <>
            <dt>Headers</dt>
            <dd>
              <KeyValues pairs={m.headers} />
            </dd>
          </>
        )}
        <Field label="File" value={m.path} />
        {m.key !== m.name && <Field label="In /mcp" value={m.key} />}
      </dl>

      <div className="setup-check">
        <div className="setup-check-bar">
          <button className="btn primary" onClick={() => onCheck(m)} disabled={!!m.uncheckable || result === 'running'} title={m.uncheckable ?? 'Start it, ask for its tools, and stop it'}>
            {result === 'running' ? <LoaderCircle size={13} className="spin" /> : <Plug size={13} />} Check
          </button>
          <span className="hint">{m.uncheckable ?? (m.transport === 'stdio' ? 'Starts it, asks for its tools, then stops it.' : 'Connects, asks for its tools, then disconnects.')}</span>
        </div>
        {result === 'running' ? (
          <p className="setup-empty">Asking it for its tools…</p>
        ) : result?.ok ? (
          <div className="check-result ok" role="status">
            <p>
              <CircleCheck size={14} /> Answered in {result.ms < 1000 ? `${result.ms} ms` : `${(result.ms / 1000).toFixed(1)} s`}
              {result.server ? ` · ${result.server}` : ''}
              {result.protocolVersion ? ` · protocol ${result.protocolVersion}` : ''}
            </p>
            <h3 className="section-label">
              {result.tools.length} {result.tools.length === 1 ? 'tool' : 'tools'}
            </h3>
            <ul className="tool-list">
              {result.tools.map((t) => (
                <li key={t.name}>
                  <span className="mono">{t.name}</span>
                  {t.description && <span className="tool-desc">{t.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        ) : result ? (
          <div className={cx('check-result', result.needsAuth ? 'warn' : 'bad')} role="status">
            <p>
              {result.needsAuth ? <TriangleAlert size={14} /> : <CircleX size={14} />} {result.error}
            </p>
            {result.log && <pre className="setup-log">{result.log}</pre>}
          </div>
        ) : null}
      </div>
    </>
  )
}

function KeyValues({ pairs }: { pairs: [string, string][] }) {
  return (
    <table className="kv">
      <tbody>
        {pairs.map(([k, v]) => (
          <tr key={k}>
            <td className="mono">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HookDetail({ hook: h }: { hook: HookEntry }) {
  return (
    <>
      <div className="setup-detail-head">
        <span className="page-kicker">Hook · {h.type}</span>
        <h2>{h.event}</h2>
        <ScopeBadge scope={h.scope} plugin={h.plugin} />
      </div>
      {h.off && <p className="setup-note">Off: disableAllHooks is set where this applies.</p>}
      <dl className="setup-meta">
        <Field label="Matcher" value={h.matcher || 'Everything'} mono={!!h.matcher} />
        <dt>{h.type === 'command' ? 'Runs' : h.type === 'http' ? 'Posts to' : h.type === 'prompt' || h.type === 'agent' ? 'Prompt' : 'Calls'}</dt>
        <dd>
          <pre className="setup-log">{h.run}</pre>
        </dd>
        {h.timeout !== undefined && <Field label="Timeout" value={`${h.timeout} s`} mono={false} />}
        <Field label="File" value={h.path} />
      </dl>
    </>
  )
}

interface PluginDetailProps {
  plugin: PluginEntry
  onShow: (id: SectionId, plugin: string) => void
  /** Its MCP servers, to switch them all at once. */
  servers: McpEntry[]
  busy: boolean
  onSwitch: (servers: McpEntry[], on: boolean) => void
}

function PluginDetail({ plugin: p, onShow, servers, busy, onSwitch }: PluginDetailProps) {
  const switchable = servers.filter((m) => !m.fixed)
  const onNow = switchable.filter(switchedOn)
  const offNow = switchable.filter((m) => !switchedOn(m))
  const provides = (Object.entries(p.provides) as [SectionId, number][]).filter(([, n]) => n > 0)
  const words: Record<string, [string, string]> = {
    skills: ['skill', 'skills'],
    commands: ['command', 'commands'],
    agents: ['agent', 'agents'],
    hooks: ['hook', 'hooks'],
    mcp: ['MCP server', 'MCP servers'],
  }
  return (
    <>
      <div className="setup-detail-head">
        <span className="page-kicker">Plugin</span>
        <h2>{p.name}</h2>
        <span className={cx('state-pill', p.enabled ? 'state-on' : 'state-off')}>{p.enabled ? 'On' : 'Off'}</span>
      </div>
      {p.description && <p className="setup-desc">{p.description}</p>}
      {p.missing && <p className="setup-note">Enabled, but its files are not there: reinstall it in claude (/plugin).</p>}
      <dl className="setup-meta">
        <Field label="Id" value={p.id} />
        {p.source && <Field label="Marketplace" value={`${p.marketplace} · ${p.source}`} />}
        {p.synced && <Field label="From" value="Synced from claude.ai" mono={false} />}
        {p.version && <Field label="Version" value={p.version} />}
        {p.author && <Field label="Author" value={p.author} mono={false} />}
        {p.homepage && <Field label="Homepage" value={p.homepage} />}
        <Field label="State" value={p.setIn ? `${p.enabled ? 'On' : 'Off'} in ${p.setIn}` : p.enabled ? 'On' : 'Off: not in enabledPlugins'} mono={false} />
        {p.path && <Field label="Folder" value={p.path} />}
      </dl>
      {provides.length > 0 && (
        <>
          <h3 className="section-label">{p.enabled ? 'Brings' : 'Would bring'}</h3>
          <div className="setup-provides">
            {provides.map(([id, n]) => (
              <button key={id} className="chip" onClick={() => onShow(id, p.name)} disabled={!p.enabled} title={p.enabled ? `Show them` : 'Off, so they are not listed'}>
                {n} {words[id][n === 1 ? 0 : 1]}
              </button>
            ))}
          </div>
        </>
      )}
      {p.enabled && switchable.length > 0 && (
        <>
          <h3 className="section-label">Its MCP servers</h3>
          <div className="setup-check-bar">
            <span className="hint">
              {onNow.length} of {switchable.length} on
            </span>
            <button className="btn" onClick={() => onSwitch(onNow, false)} disabled={busy || !onNow.length}>
              Turn all off
            </button>
            <button className="btn" onClick={() => onSwitch(offNow, true)} disabled={busy || !offNow.length}>
              Turn all on
            </button>
          </div>
        </>
      )}
    </>
  )
}
