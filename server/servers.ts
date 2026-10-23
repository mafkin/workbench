// Servers running in a profile's projects: your processes listening on a TCP
// port whose folder is inside a project (the deepest project wins), plus the
// servers a project declares (`servers:`), which show "down" when nothing
// answers. Each gets an HTTP check. Stopping one re-checks all of that first.
import fsp from 'node:fs/promises'
import { displayPath, type NavItem, type Profile, type ProjectServers, type ServerHealth, type ServerRow, type ServersScan } from '../shared/config-schema.ts'
import { StoreError, type ConfigStore } from './config-store.ts'
import { absPath, realish, within } from './paths.ts'
import { Procfs } from './procfs.ts'

export interface ServersOptions {
  procRoot?: string
  /** How long a scan is reused (the page and the nav marks poll at once). */
  cacheMs?: number
}

/** Answers HTTP (any status), takes connections but not HTTP, or nothing. */
async function probe(url: string, listening: boolean): Promise<ServerHealth> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
    await res.body?.cancel()
    return { state: 'up', code: res.status, text: `${res.status}${res.statusText ? ` ${res.statusText}` : ''}` }
  } catch {
    return listening ? { state: 'listening', text: 'listening' } : { state: 'down', text: 'not answering' }
  }
}

const hostFor = (address: string) => (address === '::1' ? '[::1]' : '127.0.0.1')
const portOf = (url: string) => {
  try {
    const u = new URL(url)
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch {
    return null
  }
}

function projectsOf(profile: Profile): Extract<NavItem, { type: 'folder' }>[] {
  const out: Extract<NavItem, { type: 'folder' }>[] = []
  for (const section of profile.sections) {
    for (const item of section.items) {
      if (item.type === 'folder') out.push(item)
      if (item.type === 'group') for (const child of item.items) if (child.type === 'folder') out.push(child)
    }
  }
  return out
}

export class Servers {
  #store: ConfigStore
  #home: string
  #proc: Procfs
  #cacheMs: number
  #cache = new Map<string, { at: number; rev: string; scan: Promise<ServersScan> }>()

  constructor(store: ConfigStore, home: string, opts: ServersOptions = {}) {
    this.#store = store
    this.#home = home
    this.#proc = new Procfs(opts.procRoot)
    this.#cacheMs = opts.cacheMs ?? 1000
  }

  scan(id: string): Promise<ServersScan> {
    // A scan of the profile as it was before an edit lists the old projects.
    const rev = this.#store.profile(id).rev
    const hit = this.#cache.get(id)
    if (hit && hit.rev === rev && Date.now() - hit.at < this.#cacheMs) return hit.scan
    const scan = this.#scan(id)
    this.#cache.set(id, { at: Date.now(), rev, scan })
    scan.catch(() => this.#cache.delete(id))
    return scan
  }

  /** Stop a server the scan lists: SIGTERM to its process, after checking it again. */
  async stop(id: string, pid: number, port: number): Promise<void> {
    this.#cache.delete(id)
    const scan = await this.scan(id)
    const row = scan.projects.flatMap((p) => p.rows).find((r) => r.pid === pid && r.port === port)
    if (!row) throw new StoreError("Not a server running in this profile's projects", 404)
    try {
      process.kill(pid, 'SIGTERM')
    } catch (err) {
      throw new StoreError(`Could not stop it: ${(err as NodeJS.ErrnoException).code ?? err}`, 409)
    }
    this.#cache.delete(id)
  }

  async #scan(id: string): Promise<ServersScan> {
    const p = this.#store.profile(id)
    if (!p.profile) throw new StoreError('The profile file is broken', 423)
    const projects = []
    for (const item of projectsOf(p.profile)) {
      let real: string | null = null
      try {
        real = await realish(absPath(item.path, this.#home))
      } catch {
        // A path that cannot be resolved has nothing running in it.
      }
      projects.push({ item, real })
    }
    const uid = process.getuid?.() ?? -1
    const listeners = (await this.#proc.listeners()).filter((l) => l.uid === uid)
    const owners = await this.#proc.owners(new Set(listeners.map((l) => l.inode)), uid)
    const found = new Map<string, ServerRow[]>()
    const seen = new Set<string>()
    for (const l of listeners) {
      const pid = owners.get(l.inode)
      if (!pid || pid === process.pid || seen.has(`${pid}:${l.port}`)) continue
      seen.add(`${pid}:${l.port}`)
      const info = await this.#proc.process(pid)
      if (!info) continue
      const cwd = await fsp.realpath(info.cwd).catch(() => info.cwd)
      const home = projects
        .filter((x) => x.real && within(cwd, x.real))
        .sort((a, b) => b.real!.length - a.real!.length)[0]
      if (!home) continue
      const url = `http://${hostFor(l.address)}:${l.port}/`
      const rows = found.get(home.item.path) ?? []
      rows.push({
        id: `port:${l.port}`,
        declared: false,
        port: l.port,
        pid,
        process: info.name,
        command: info.command.join(' '),
        cwd: displayPath(cwd, this.#home),
        started: info.started || undefined,
        url,
        health: { state: 'listening', text: 'listening' },
      })
      found.set(home.item.path, rows)
    }

    const out: ProjectServers[] = []
    for (const { item } of projects) {
      const rows = (found.get(item.path) ?? []).sort((a, b) => (a.port ?? 0) - (b.port ?? 0))
      const extra: ServerRow[] = []
      for (const decl of item.servers ?? []) {
        const port = decl.port ?? (decl.url ? portOf(decl.url) : null)
        const match = rows.find((r) => r.port === port)
        if (match) {
          match.name = decl.name
          match.declared = true
          if (decl.url) match.url = decl.url
        } else {
          extra.push({ id: `name:${decl.name}`, name: decl.name, declared: true, port: null, url: decl.url ?? (port ? `http://127.0.0.1:${port}/` : null), health: { state: 'down', text: 'not answering' } })
        }
      }
      const all = [...rows, ...extra]
      await Promise.all(all.map(async (r) => r.url && (r.health = await probe(r.url, r.pid !== undefined))))
      out.push({ label: item.label, path: item.path, rows: all })
    }
    return { at: Date.now(), projects: out }
  }
}
