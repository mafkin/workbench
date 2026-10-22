// Servers running in the profile's projects, found by the folder they run in,
// plus those projects declare (`servers:`). Checked every 3 s while the page is
// open; Open, Copy URL and Stop (which asks first) on each. A lazy chunk.
import { Copy, ExternalLink, RefreshCw, Server, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ServerRow, ServersScan } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { cx } from '../lib/nav.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import type { ToastInput } from './Toast.tsx'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "12 s", "5 min", "3 h", "2 d". */
function since(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86_400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} d`
}

interface Props {
  profileId: string
  /** Each scan, so the nav's marks follow the page. */
  onScan: (scan: ServersScan) => void
  toast: (t: ToastInput) => void
}

export default function ServersView({ profileId, onScan, toast }: Props) {
  const [scan, setScan] = useState<ServersScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [stopping, setStopping] = useState<ServerRow | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    const load = () =>
      api.servers(profileId).then(
        (s) => {
          if (!live) return
          setScan(s)
          setError(null)
          onScan(s)
        },
        (err) => live && setError(message(err)),
      )
    void load()
    const poll = setInterval(load, 3000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      live = false
      clearInterval(poll)
      clearInterval(clock)
    }
  }, [profileId, tick])

  async function stop(row: ServerRow) {
    setStopping(null)
    if (!row.pid || !row.port) return
    try {
      await api.stopServer(profileId, row.pid, row.port)
      toast({ message: `Stopped ${row.process ?? 'the server'} on :${row.port}` })
      setTick((t) => t + 1)
    } catch (err) {
      toast({ message: message(err), kind: 'error' })
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast({ message: 'URL copied' })
    } catch {
      toast({ message: 'Could not copy to the clipboard', kind: 'error' })
    }
  }

  const busy = scan?.projects.filter((p) => p.rows.length) ?? []
  const quiet = scan?.projects.filter((p) => !p.rows.length) ?? []

  return (
    <div className="page servers-page">
      <div className="page-kicker">Projects</div>
      <h1 className="page-title">
        <Server size={22} className="icon" /> Servers
      </h1>
      <p className="page-sub">
        What runs in this profile's projects: your programs listening on a port, found by the folder they run in, and the servers a project names in{' '}
        <span className="mono">servers:</span>. Checked every 3 s.
      </p>
      <div className="servers-bar">
        <span className="hint">{error ? <span className="err">{error}</span> : scan ? `Updated ${since(scan.at, now)} ago` : 'Looking…'}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw size={13} /> Check now
        </button>
      </div>

      {scan && busy.length === 0 && <p className="servers-none">Nothing is running in this profile's projects.</p>}
      {busy.map((p) => (
        <section key={p.path} className="servers-project" aria-label={p.label}>
          <h2>
            {p.label} <span className="mono">{p.path}</span>
          </h2>
          <ul>
            {p.rows.map((r) => (
              <li key={r.id} className={cx('server-row', r.health.state)}>
                <span className={cx('server-dot', r.health.state)} aria-label={r.health.state} />
                <span className="server-what">
                  <span className="mono port">{r.port ? `:${r.port}` : r.name}</span>
                  {r.port && r.name && <span className="server-name">{r.name}</span>}
                  {r.process && (
                    <span className="server-process" title={r.command}>
                      {r.process}
                    </span>
                  )}
                  {r.cwd && r.cwd !== p.path && <span className="mono server-cwd">{r.cwd}</span>}
                </span>
                <span className="server-up">{r.started ? `up ${since(r.started, now)}` : r.declared && !r.pid ? 'declared' : ''}</span>
                <span className={cx('server-health', r.health.state)}>{r.health.text}</span>
                <span className="server-actions">
                  {r.url && (
                    <a className="icon-btn" href={r.url} target="_blank" rel="noreferrer" title={`Open ${r.url}`} aria-label={`Open ${r.port ?? r.name}`}>
                      <ExternalLink size={13} />
                    </a>
                  )}
                  {r.url && (
                    <button className="icon-btn" onClick={() => void copy(r.url!)} title="Copy URL" aria-label={`Copy URL of ${r.port ?? r.name}`}>
                      <Copy size={13} />
                    </button>
                  )}
                  {r.pid && (
                    <button className="icon-btn danger" onClick={() => setStopping(r)} title="Stop" aria-label={`Stop ${r.port}`}>
                      <Square size={12} />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {quiet.length > 0 && (
        <section className="servers-quiet">
          <h2 className="section-label">Nothing running</h2>
          <p>{quiet.map((p) => p.label).join(' · ')}</p>
        </section>
      )}

      {stopping && (
        <ConfirmDialog title={`Stop ${stopping.process ?? 'the server'} on :${stopping.port}?`} action="Stop" onCancel={() => setStopping(null)} onConfirm={() => void stop(stopping)}>
          Sends SIGTERM to process {stopping.pid}
          {stopping.command ? ` (${stopping.command.length > 120 ? `${stopping.command.slice(0, 120)}…` : stopping.command})` : ''}, as Ctrl+C would.
        </ConfirmDialog>
      )}
    </div>
  )
}
