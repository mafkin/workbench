// MCP servers on and off per folder, the way claude's /mcp does it: the
// `disabledMcpServers` list in the folder's entry of `~/.claude.json` (keyed by
// `projectKey`). Claude re-reads that file when it changes, so a running claude
// keeps what is written here. Only that one list is touched; the rest of the
// file (tokens included) is written back as it was read.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { StoreError } from './config-store.ts'
import { writeAtomic } from './fs-util.ts'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

let queue: Promise<unknown> = Promise.resolve()
/** One write at a time, so two switches never read the same old file. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => {})
  return next
}

/** Turn `keys` off (or back on) for the folders filed under `projectKeys`. A missing file is made (0600). */
export function setFoldersOff(file: string, projectKeys: string[], keys: string[], off: boolean): Promise<void> {
  return serial(async () => {
    let text: string | null = null
    let mode = 0o600
    try {
      text = await fsp.readFile(file, 'utf8')
      mode = (await fsp.stat(file)).mode & 0o777
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    let data: unknown = {}
    if (text !== null) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new StoreError(`${path.basename(file)} is not valid JSON; fix it in claude first`, 423)
      }
    }
    if (!isObj(data)) throw new StoreError(`${path.basename(file)} is not a JSON object`, 423)
    if (data.projects !== undefined && !isObj(data.projects)) throw new StoreError(`"projects" in ${path.basename(file)} is not an object`, 423)
    const projects = (data.projects ??= {}) as Json
    let changed = false
    for (const pk of projectKeys) {
      const entry = isObj(projects[pk]) ? projects[pk] : (projects[pk] = {})
      const was = Array.isArray(entry.disabledMcpServers) ? (entry.disabledMcpServers as unknown[]) : []
      const now = off ? [...was, ...keys.filter((k) => !was.includes(k))] : was.filter((k) => typeof k !== 'string' || !keys.includes(k))
      if (now.length === was.length && Array.isArray(entry.disabledMcpServers)) continue
      entry.disabledMcpServers = now
      changed = true
    }
    if (changed) await writeAtomic(file, JSON.stringify(data, null, 2), mode)
  })
}

/**
 * The profile's `mcpOff:` defaults, applied once per folder: the ledger
 * (`mcp-defaults.json` in the state dir) records which names each folder has
 * had turned off, so one switched back on there stays on.
 */
export class McpDefaults {
  readonly #file: string
  readonly #claudeJson: string
  #data: Record<string, string[]> | null = null

  constructor(opts: { stateDir: string; claudeJson: string }) {
    this.#file = path.join(opts.stateDir, 'mcp-defaults.json')
    this.#claudeJson = opts.claudeJson
  }

  async #load(): Promise<Record<string, string[]>> {
    if (this.#data) return this.#data
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(this.#file, 'utf8'))
      this.#data = {}
      if (isObj(raw)) for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) this.#data[k] = v.filter((x): x is string => typeof x === 'string')
    } catch {
      this.#data = {}
    }
    return this.#data
  }

  async #save() {
    await fsp.mkdir(path.dirname(this.#file), { recursive: true })
    await writeAtomic(this.#file, JSON.stringify(this.#data, null, 2), 0o600)
  }

  /** Before a chat starts in the folder filed under `projectKey`: turn off the defaults it hasn't had yet. */
  async apply(off: string[] | undefined, projectKey: string): Promise<string[]> {
    if (!off?.length) return []
    const data = await this.#load()
    const done = data[projectKey] ?? []
    const todo = off.filter((k) => !done.includes(k))
    if (!todo.length) return []
    await setFoldersOff(this.#claudeJson, [projectKey], todo, true)
    data[projectKey] = [...done, ...todo]
    await this.#save()
    return todo
  }

  /** Turned off everywhere now: these folders have had them. */
  async noteApplied(projectKeys: string[], keys: string[]) {
    const data = await this.#load()
    for (const pk of projectKeys) data[pk] = [...new Set([...(data[pk] ?? []), ...keys])]
    await this.#save()
  }

  /** No longer defaults: forget them, so making one a default again applies it again. */
  async forget(keys: string[]) {
    const data = await this.#load()
    for (const pk of Object.keys(data)) data[pk] = data[pk].filter((k) => !keys.includes(k))
    await this.#save()
  }
}
