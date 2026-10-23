// One chat in the main pane: a slim bar (agent, folder, state, Summarize and
// continue) over its terminal. A stopped chat (after a restart of the service)
// offers Resume instead of starting by itself; a chat step or entry also offers
// the earlier Claude sessions in its folder.
import { FastForward, Play, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { agentSummary, findAgent, type Chat, type ClaudeSession } from '../../shared/config-schema.ts'
import { useChats } from '../lib/chats.ts'
import { cx } from '../lib/nav.ts'
import { ago } from '../lib/recent.ts'
import { agentIcon } from './EntryIcon.tsx'

const ChatTerminal = lazy(() => import('./ChatTerminal.tsx'))

/** Claude's own suggestion point for a fresh session. */
const LONG_CHAT = 40

interface Props {
  chat: Chat | null
  /** A chat step or entry: start its chat, or resume an earlier session there. */
  start?: (resume?: string) => Promise<Chat | null>
  /** Where a step's or entry's earlier sessions are looked up. */
  historyPath?: string
}

export function ChatPane({ chat, start, historyPath }: Props) {
  const chats = useChats()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const started = useRef(false)

  // A chat step or entry starts its chat the first time it is opened.
  useEffect(() => {
    if (chat || !start || started.current || !chats.loaded) return
    started.current = true
    setBusy('Starting…')
    void start().then((c) => {
      setBusy(null)
      setFailed(!c)
    })
  }, [chat, start, chats.loaded])

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label)
    await fn()
    setBusy(null)
  }

  if (!chat) {
    return (
      <div className="chat-pane">
        <div className="chat-stopped">
          {busy ? (
            <p>{busy}</p>
          ) : (
            <>
              <p>{failed ? 'The chat could not start.' : 'This chat is not running.'}</p>
              {start && (
                <button
                  className="btn primary"
                  onClick={() =>
                    void run('Starting…', async () => {
                      setFailed(!(await start()))
                    })
                  }
                >
                  <Play size={14} /> Start
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  const claude = chat.agent === 'claude'
  const Icon = agentIcon(chat.agent)
  const program = claude ? 'claude' : 'The shell'
  const state = chat.state === 'running' ? 'Running' : chat.state === 'exited' ? `Exited${chat.exitCode ? ` (code ${chat.exitCode})` : ''}` : 'Stopped'
  // The agent profile as it is now; the chat keeps the settings it started with.
  const profile = chat.agentProfile ? findAgent({ agents: chats.agents }, chat.agentProfile) : null
  const summary = profile ? agentSummary(profile[1]) : ''

  const again = (
    <>
      {claude && chat.session ? (
        <>
          <button className="btn primary" disabled={!!busy} onClick={() => void run('Resuming…', () => chats.restart(chat, false))}>
            <Play size={14} /> Resume
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void run('Starting…', () => chats.restart(chat, true))}>
            <RotateCcw size={14} /> New session
          </button>
        </>
      ) : (
        <button className="btn primary" disabled={!!busy} onClick={() => void run('Starting…', () => chats.restart(chat, true))}>
          <Play size={14} /> Start again
        </button>
      )}
      {busy && <span className="chat-busy">{busy}</span>}
    </>
  )

  return (
    <div className="chat-pane">
      <div className="chat-bar">
        <Icon size={14} className="icon" />
        {chat.agentProfile && (
          <span className="chat-agent" title={summary ? `${chat.agentProfile}: ${summary}` : chat.agentProfile}>
            {chat.agentProfile}
            {summary && <span className="detail"> · {summary}</span>}
          </span>
        )}
        {chat.bypass && (
          <span className="bypass-note" title="Started with permissions bypassed: claude runs every tool without asking" aria-label="Permissions bypassed">
            <ShieldAlert size={13} />
          </span>
        )}
        {chat.context && (
          <span className="chat-context" title="Started with this profile's context folders and its wiki (--add-dir), the routing note and, in a project, the name of its page">
            context · wiki
          </span>
        )}
        <span className="mono chat-where" title={chat.cwd}>
          {chat.cwd}
        </span>
        <span className={cx('chat-state', chat.state)}>{state}</span>
        <span className="spacer" />
        {claude && chat.session && (
          <button
            className={cx('btn ghost small', chat.messages >= LONG_CHAT && 'long')}
            disabled={!!busy}
            title="Claude writes a handoff of this session, and a new chat starts from it"
            onClick={() =>
              void run('Summarizing…', async () => {
                const next = await chats.handoff(chat)
                if (next) chats.open(next)
              })
            }
          >
            <FastForward size={13} />
            {busy === 'Summarizing…' ? 'Summarizing…' : chat.messages >= LONG_CHAT ? `${chat.messages} messages · Summarize and continue` : 'Summarize and continue'}
          </button>
        )}
      </div>
      {chat.state === 'stopped' ? (
        <div className="chat-stopped">
          <p>
            {program} stopped when the service restarted.
            {claude && chat.session ? ' Resume picks up the conversation.' : ''}
          </p>
          <div className="chat-actions">{again}</div>
          {historyPath && <EarlierSessions path={historyPath} current={chat.session} onResume={start} />}
        </div>
      ) : (
        <>
          <Suspense fallback={<div className="chat-terminal" />}>
            <ChatTerminal key={chat.id} id={chat.id} />
          </Suspense>
          {chat.state === 'exited' && (
            <div className="chat-ended">
              <span>
                {program} exited{chat.exitCode ? ` with code ${chat.exitCode}` : ''}.
              </span>
              {again}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Earlier Claude sessions in a step's or entry's folder, to resume there. */
function EarlierSessions({ path, current, onResume }: { path: string; current: string | null; onResume?: (resume?: string) => Promise<Chat | null> }) {
  const chats = useChats()
  const [sessions, setSessions] = useState<ClaudeSession[] | null>(null)

  useEffect(() => {
    let live = true
    void chats.history(path).then((s) => live && setSessions(s.filter((x) => x.id !== current).slice(0, 8)))
    return () => {
      live = false
    }
  }, [path, current])

  if (!onResume || !sessions?.length) return null
  return (
    <div className="earlier-sessions">
      <h3 className="section-label">Earlier sessions here</h3>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <button onClick={() => void onResume(s.id)}>
              <Sparkles size={13} className="icon" />
              <span className="label">{s.title}</span>
              <span className="when">{ago(s.mtime)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
