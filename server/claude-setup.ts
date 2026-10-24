// What claude loads, read from its files: skills, commands, agents, MCP servers,
// hooks and plugins, for everywhere or for one folder. Nothing is written.
// Formats that are not documented are read leniently: a file of an unexpected
// shape is skipped and reported as a problem, never a failure. Secrets are
// masked here; the raw MCP configs stay in the service, for checks.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { frontmatter } from './frontmatter.ts'
import type { ClaudeSetup, DocKind, HookEntry, McpEntry, McpState, McpTransport, PluginEntry, SetupDoc, SetupProblem, SetupScope } from '../shared/claude-setup.ts'
import { claudeDir as defaultClaudeDir } from './claude-sessions.ts'
import { maskArgs, maskHeader, maskText, maskUrl, maskValue } from './mask.ts'

export const MANAGED_DIR = '/etc/claude-code'

export interface SetupOptions {
  home: string
  /** `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir?: string
  /** `~/.claude.json`, or inside `$CLAUDE_CONFIG_DIR` when that is set. */
  globalFile?: string
  /** `/etc/claude-code`. */
  managedDir?: string
  /** The folder whose project and local items count; none for everywhere. */
  folder?: string | null
  /** The profile's wiki: its `skills/` folder lists as scope `wiki` (loaded only in chats that pin them). */
  wiki?: string | null
}

export interface RawServer {
  entry: McpEntry
  /** As written, secrets and all. */
  config: Record<string, unknown>
  /** `${CLAUDE_PLUGIN_ROOT}` for a plugin's server. */
  pluginRoot?: string
}

export interface SetupRead {
  setup: ClaudeSetup
  /** By entry id, for checks; never sent to the browser. */
  servers: Map<string, RawServer>
  /** By document id: the file of each skill, agent and command. */
  files: Map<string, string>
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])
const errCode = (err: unknown) => (err as NodeJS.ErrnoException).code

export const claudeJson = (home: string) => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'))

export { frontmatter }

/** A JSON parse error without the text it quotes, which may hold a secret. */
function jsonError(err: unknown): string {
  const m = /(line \d+ column \d+)|(position \d+)/.exec(String((err as Error).message))
  return m ? `Not valid JSON (at ${m[0]})` : 'Not valid JSON'
}

const display = (v: unknown): string => {
  const s = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return maskText(s.length > 400 ? `${s.slice(0, 400)}…` : s)
}

const firstLine = (body: string) => (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim()

const wildcard = (pattern: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

async function isDir(p: string) {
  return (await fsp.stat(p).catch(() => null))?.isDirectory() ?? false
}
async function isFile(p: string) {
  return (await fsp.stat(p).catch(() => null))?.isFile() ?? false
}
async function names(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b))
}

/** `.md` files under `dir`, as paths relative to it. */
async function markdownFiles(dir: string, recursive: boolean, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const name of await names(path.join(dir, rel))) {
    const r = path.join(rel, name)
    if (name.endsWith('.md') && (await isFile(path.join(dir, r)))) out.push(r)
    else if (recursive && !name.startsWith('.') && (await isDir(path.join(dir, r)))) out.push(...(await markdownFiles(dir, true, r)))
  }
  return out
}

interface SettingsFile {
  scope: SetupScope
  path: string
  data: Json
}

interface Plugin {
  entry: PluginEntry
  root: string | null
  manifest: Json
  manifestPath: string
}

interface ServerDef {
  name: string
  scope: SetupScope
  plugin?: string
  pluginRoot?: string
  config: unknown
  file: string
}

class Reader {
  readonly problems: SetupProblem[] = []
  readonly files = new Map<string, string>()
  readonly servers = new Map<string, RawServer>()
  readonly home: string

  constructor(home: string) {
    this.home = home
  }

  tilde = (p: string) => (p === this.home ? '~' : p.startsWith(`${this.home}/`) ? `~${p.slice(this.home.length)}` : p)

  problem(p: string, message: string) {
    this.problems.push({ path: this.tilde(p), message })
  }

  async json(file: string): Promise<Json | undefined> {
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (err) {
      if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') this.problem(file, `Cannot read it (${errCode(err) ?? 'error'})`)
      return undefined
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (err) {
      this.problem(file, jsonError(err))
      return undefined
    }
    if (!isObj(value)) {
      this.problem(file, 'Not a JSON object')
      return undefined
    }
    return value
  }

  /** A skill, agent or command file; null when claude would skip it. */
  async doc(kind: DocKind, file: string, scope: SetupScope, fallbackName: string, extra: { plugin?: string; prefix?: string; synced?: boolean } = {}): Promise<SetupDoc | null> {
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (err) {
      this.problem(file, `Cannot read it (${errCode(err) ?? 'error'})`)
      return null
    }
    const fm = frontmatter(text)
    if (fm.error) this.problem(file, `The frontmatter is not valid YAML: ${fm.error}`)
    const own = kind === 'command' ? undefined : str(fm.data.name)
    const description = str(fm.data.description) ?? (kind === 'agent' ? '' : firstLine(fm.body))
    if (kind === 'agent' && (!own || !description)) {
      this.problem(file, 'Skipped by claude: an agent needs a name and a description')
      return null
    }
    const name = `${extra.prefix ?? ''}${own ?? fallbackName}`
    const id = `${kind}:${file}`
    this.files.set(id, file)
    const fields = Object.entries(fm.data)
      .filter(([k]) => k !== 'name' && k !== 'description')
      .map(([k, v]): [string, string] => [k, display(v)])
    return {
      id,
      kind,
      name,
      description: maskText(description),
      scope,
      ...(extra.plugin ? { plugin: extra.plugin } : {}),
      ...(extra.synced ? { synced: true } : {}),
      path: this.tilde(file),
      fields,
    }
  }

  /** Skill folders (each with a SKILL.md) in `dir`, or `dir` itself when it is one. */
  async skills(dir: string, scope: SetupScope, extra: { plugin?: string; prefix?: string; synced?: boolean } = {}): Promise<SetupDoc[]> {
    if (await isFile(path.join(dir, 'SKILL.md'))) {
      const d = await this.doc('skill', path.join(dir, 'SKILL.md'), scope, path.basename(dir), extra)
      return d ? [d] : []
    }
    const out: SetupDoc[] = []
    for (const name of await names(dir)) {
      if (scope === 'user' && name === 'synced' && !extra.synced) continue
      const file = path.join(dir, name, 'SKILL.md')
      if (!(await isFile(file))) continue
      const d = await this.doc('skill', file, scope, name, extra)
      if (d) out.push(d)
    }
    return out
  }

  /** Commands: a subfolder is part of the name (`frontend/component.md` is `frontend:component`). */
  async commands(dirOrFile: string, scope: SetupScope, extra: { plugin?: string; prefix?: string } = {}): Promise<SetupDoc[]> {
    const one = dirOrFile.endsWith('.md') && (await isFile(dirOrFile))
    const base = one ? path.dirname(dirOrFile) : dirOrFile
    const rels = one ? [path.basename(dirOrFile)] : await markdownFiles(base, true)
    const out: SetupDoc[] = []
    for (const rel of rels) {
      const d = await this.doc('command', path.join(base, rel), scope, rel.slice(0, -3).split(path.sep).join(':'), extra)
      if (d) out.push(d)
    }
    return out
  }

  /** Agents: plugin agents may sit in subfolders, which become part of the name. */
  async agents(dirOrFile: string, scope: SetupScope, extra: { plugin?: string; prefix?: string } = {}): Promise<SetupDoc[]> {
    const one = dirOrFile.endsWith('.md') && (await isFile(dirOrFile))
    const base = one ? path.dirname(dirOrFile) : dirOrFile
    const rels = one ? [path.basename(dirOrFile)] : await markdownFiles(base, scope === 'plugin')
    const out: SetupDoc[] = []
    for (const rel of rels) {
      const sub = path.dirname(rel) === '.' ? '' : `${path.dirname(rel).split(path.sep).join(':')}:`
      const d = await this.doc('agent', path.join(base, rel), scope, path.basename(rel, '.md'), { ...extra, prefix: `${extra.prefix ?? ''}${sub}` })
      if (d) out.push(d)
    }
    return out
  }

  hooks(hooks: unknown, scope: SetupScope, file: string, plugin?: string): HookEntry[] {
    if (hooks === undefined) return []
    if (!isObj(hooks)) {
      this.problem(file, '"hooks" is not an object')
      return []
    }
    const out: HookEntry[] = []
    for (const [event, groups] of Object.entries(hooks)) {
      listOf(groups).forEach((group, gi) => {
        if (!isObj(group)) return
        listOf(group.hooks).forEach((h, hi) => {
          if (!isObj(h)) return
          const type = str(h.type) ?? 'command'
          const run =
            type === 'command'
              ? maskText([String(h.command ?? ''), ...strings(h.args)].join(' ').trim())
              : type === 'http'
                ? maskUrl(String(h.url ?? ''))
                : type === 'prompt' || type === 'agent'
                  ? maskText(String(h.prompt ?? ''))
                  : maskText(JSON.stringify(Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'type'))))
          out.push({
            id: `hook:${file}:${event}:${gi}:${hi}`,
            event,
            matcher: typeof group.matcher === 'string' ? group.matcher : '',
            type,
            run: run.length > 600 ? `${run.slice(0, 600)}…` : run,
            ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}),
            scope,
            ...(plugin ? { plugin } : {}),
            path: this.tilde(file),
          })
        })
      })
    }
    return out
  }
}

/** The folder and its parents up to the git root (nearest first); just the folder outside a repo. */
async function projectDirs(folder: string, home: string): Promise<string[]> {
  const chain: string[] = []
  for (let cur = folder; ; ) {
    chain.push(cur)
    if ((await fsp.stat(path.join(cur, '.git')).catch(() => null)) !== null) return chain
    const parent = path.dirname(cur)
    if (parent === cur || cur === home) return [folder]
    cur = parent
  }
}

/**
 * The key claude files a folder's state under in `~/.claude.json` `projects`:
 * the repository's top folder when the folder is inside one, else the folder (real paths).
 */
export async function projectKey(folder: string): Promise<string> {
  const real = await fsp.realpath(folder).catch(() => path.resolve(folder))
  for (let cur = real; ; ) {
    if ((await fsp.stat(path.join(cur, '.git')).catch(() => null)) !== null) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return real
    cur = parent
  }
}

const findProject = (projects: unknown, key: string): Json | undefined => {
  if (!isObj(projects)) return undefined
  const v = projects[key]
  return isObj(v) ? v : undefined
}

export async function readSetup(opts: SetupOptions): Promise<SetupRead> {
  const { home } = opts
  const cdir = opts.claudeDir ?? defaultClaudeDir(home)
  const managedDir = opts.managedDir ?? MANAGED_DIR
  const folder = opts.folder ?? null
  const r = new Reader(home)

  // Settings, lowest precedence first: yours, the project's, the local one, managed.
  const settings: SettingsFile[] = []
  const addSettings = async (scope: SetupScope, file: string) => {
    const data = await r.json(file)
    if (data) settings.push({ scope, path: file, data })
  }
  // A folder whose .claude is yours (a project at home) has no project files of its own there.
  const realClaude = await fsp.realpath(cdir).catch(() => cdir)
  const isYours = async (dotClaude: string) => (await fsp.realpath(dotClaude).catch(() => dotClaude)) === realClaude
  await addSettings('user', path.join(cdir, 'settings.json'))
  if (folder) {
    if (!(await isYours(path.join(folder, '.claude')))) await addSettings('project', path.join(folder, '.claude/settings.json'))
    await addSettings('local', path.join(folder, '.claude/settings.local.json'))
  }
  await addSettings('managed', path.join(managedDir, 'managed-settings.json'))
  for (const name of await names(path.join(managedDir, 'managed-settings.d'))) {
    if (name.endsWith('.json')) await addSettings('managed', path.join(managedDir, 'managed-settings.d', name))
  }

  const globalFile = opts.globalFile ?? claudeJson(home)
  const global = (await r.json(globalFile)) ?? {}
  const projectState = folder ? findProject(global.projects, await projectKey(folder)) : undefined

  // Plugins: on or off by enabledPlugins, the last settings file that names one deciding.
  const enabled = new Map<string, { on: boolean; file: string }>()
  for (const s of settings) {
    if (s.data.enabledPlugins === undefined) continue
    if (!isObj(s.data.enabledPlugins)) {
      r.problem(s.path, '"enabledPlugins" is not an object')
      continue
    }
    for (const [id, on] of Object.entries(s.data.enabledPlugins)) enabled.set(id, { on: on === true, file: s.path })
  }
  const pluginsDir = path.join(cdir, 'plugins')
  const installedFile = path.join(pluginsDir, 'installed_plugins.json')
  const installed = await r.json(installedFile)
  let records: Json = {}
  if (installed) {
    if (isObj(installed.plugins)) records = installed.plugins
    else if (installed.version === undefined) records = installed
    else r.problem(installedFile, 'Unknown layout: no "plugins"')
  }
  const markets = (await r.json(path.join(pluginsDir, 'known_marketplaces.json'))) ?? {}
  const sourceOf = (market: string): string | undefined => {
    const m = markets[market]
    const src = isObj(m) && isObj(m.source) ? m.source : undefined
    if (!src) return undefined
    if (src.source === 'github' && str(src.repo)) return `github.com/${src.repo}`
    if (str(src.url)) return maskUrl(String(src.url))
    if (str(src.path)) return r.tilde(String(src.path))
    return undefined
  }

  const plugins: Plugin[] = []
  const addPlugin = async (id: string, root: string | null, version: string | undefined, synced: boolean) => {
    const at = id.lastIndexOf('@')
    const [idName, market] = at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, '']
    const exists = root !== null && (await isDir(root))
    const manifestPath = root ? path.join(root, '.claude-plugin/plugin.json') : ''
    const manifest = (exists && (await r.json(manifestPath))) || {}
    const state = enabled.get(id)
    const on = state ? state.on : synced || manifest.defaultEnabled === true
    const author = isObj(manifest.author) ? str(manifest.author.name) : str(manifest.author)
    plugins.push({
      root: exists ? root : null,
      manifest,
      manifestPath,
      entry: {
        id,
        name: str(manifest.name) ?? idName,
        marketplace: market,
        ...((str(manifest.version) ?? version) ? { version: str(manifest.version) ?? version } : {}),
        ...(str(manifest.description) ? { description: maskText(String(manifest.description)) } : {}),
        ...(author ? { author } : {}),
        ...(str(manifest.homepage) ? { homepage: maskUrl(String(manifest.homepage)) } : {}),
        ...(sourceOf(market) ? { source: sourceOf(market) } : {}),
        enabled: on,
        ...(state ? { setIn: r.tilde(state.file) } : {}),
        ...(exists && root ? { path: r.tilde(root) } : {}),
        ...(on && !exists ? { missing: true } : {}),
        ...(synced ? { synced: true } : {}),
        provides: { skills: 0, commands: 0, agents: 0, hooks: 0, mcp: 0 },
      },
    })
  }
  const ids = new Set([...Object.keys(records), ...enabled.keys()])
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    if (id.endsWith('@synced')) continue
    const recs = listOf(records[id]).filter(isObj)
    // A record for a project applies only in that project.
    const rec = recs.find((x) => !str(x.projectPath) || (folder !== null && path.resolve(String(x.projectPath)) === folder))
    if (recs.length && !rec) continue
    const [name, market] = [id.slice(0, id.lastIndexOf('@')), id.slice(id.lastIndexOf('@') + 1)]
    const version = rec ? str(rec.version) : undefined
    const root = rec && str(rec.installPath) ? path.resolve(String(rec.installPath)) : version ? path.join(pluginsDir, 'cache', market, name, version) : null
    await addPlugin(id, root, version, false)
  }
  // Plugins synced from claude.ai: a folder per plugin in each bucket.
  for (const bucket of await names(path.join(pluginsDir, 'synced'))) {
    const base = path.join(pluginsDir, 'synced', bucket)
    if (bucket.startsWith('.') || !(await isDir(base))) continue
    for (const sub of await names(base)) {
      const root = path.join(base, sub)
      if (sub.startsWith('.') || !(await isDir(root))) continue
      const manifest = await r.json(path.join(root, '.claude-plugin/plugin.json'))
      if (!manifest && !(await isDir(path.join(root, 'skills'))) && !(await isDir(path.join(root, 'commands')))) continue
      await addPlugin(`${str(manifest?.name) ?? sub}@synced`, root, undefined, true)
    }
  }

  // Skills: managed beats yours, which beats the project's (nearest folder first).
  const skills: SetupDoc[] = [...(await r.skills(path.join(managedDir, '.claude/skills'), 'managed')), ...(await r.skills(path.join(cdir, 'skills'), 'user'))]
  for (const bucket of await names(path.join(cdir, 'skills/synced'))) {
    if (!bucket.startsWith('.')) skills.push(...(await r.skills(path.join(cdir, 'skills/synced', bucket), 'user', { synced: true })))
  }
  const commands: SetupDoc[] = await r.commands(path.join(cdir, 'commands'), 'user')
  const userAgents: SetupDoc[] = await r.agents(path.join(cdir, 'agents'), 'user')
  const projectAgents: SetupDoc[] = []
  if (folder) {
    for (const d of await projectDirs(folder, home)) {
      const dotClaude = path.join(d, '.claude')
      if (await isYours(dotClaude)) continue
      skills.push(...(await r.skills(path.join(dotClaude, 'skills'), 'project')))
      commands.push(...(await r.commands(path.join(dotClaude, 'commands'), 'project')))
      projectAgents.push(...(await r.agents(path.join(dotClaude, 'agents'), 'project')))
    }
  }
  const agents = [...projectAgents, ...userAgents]
  const hooks: HookEntry[] = settings.flatMap((s) => r.hooks(s.data.hooks, s.scope, s.path))

  // What each plugin brings; only enabled ones count in the lists.
  const serverDefs: ServerDef[] = []
  const pluginServers: ServerDef[] = []
  for (const p of plugins) {
    if (!p.root) continue
    const root = p.root
    const name = p.entry.name
    const extra = { plugin: name, prefix: `${name}:` }
    const at = (rel: unknown) => (typeof rel === 'string' ? path.resolve(root, rel) : null)
    const pSkills = await r.skills(path.join(root, 'skills'), 'plugin', extra)
    for (const dir of listOf(p.manifest.skills)) if (at(dir)) pSkills.push(...(await r.skills(at(dir)!, 'plugin', extra)))
    const pCommands: SetupDoc[] = []
    const cmdPaths = isObj(p.manifest.commands)
      ? Object.values(p.manifest.commands).map((c) => (isObj(c) ? c.source : undefined))
      : p.manifest.commands === undefined
        ? ['./commands']
        : listOf(p.manifest.commands)
    for (const c of cmdPaths) if (at(c)) pCommands.push(...(await r.commands(at(c)!, 'plugin', extra)))
    const pAgents: SetupDoc[] = []
    for (const a of p.manifest.agents === undefined ? ['./agents'] : listOf(p.manifest.agents)) if (at(a)) pAgents.push(...(await r.agents(at(a)!, 'plugin', extra)))
    const pHooks: HookEntry[] = []
    const hookFile = path.join(root, 'hooks/hooks.json')
    const fileHooks = await r.json(hookFile)
    if (fileHooks) pHooks.push(...r.hooks(fileHooks.hooks, 'plugin', hookFile, name))
    for (const h of listOf(p.manifest.hooks)) {
      if (typeof h === 'string') {
        const f = path.resolve(root, h)
        const j = await r.json(f)
        if (j) pHooks.push(...r.hooks(j.hooks, 'plugin', f, name))
      } else if (isObj(h)) pHooks.push(...r.hooks(isObj(h.hooks) ? h.hooks : h, 'plugin', p.manifestPath, name))
    }
    const pServers: ServerDef[] = []
    const addServers = (map: unknown, file: string) => {
      const servers = isObj(map) && isObj(map.mcpServers) ? map.mcpServers : map
      if (!isObj(servers)) return
      for (const [sname, config] of Object.entries(servers)) pServers.push({ name: sname, scope: 'plugin', plugin: name, pluginRoot: root, config, file })
    }
    const mcpFile = path.join(root, '.mcp.json')
    const fileServers = await r.json(mcpFile)
    if (fileServers) addServers(fileServers, mcpFile)
    for (const m of listOf(p.manifest.mcpServers)) {
      if (typeof m === 'string') {
        const f = path.resolve(root, m)
        const j = await r.json(f)
        if (j) addServers(j, f)
      } else addServers(m, p.manifestPath)
    }
    p.entry.provides = { skills: pSkills.length, commands: pCommands.length, agents: pAgents.length, hooks: pHooks.length, mcp: pServers.length }
    if (!p.entry.enabled) continue
    skills.push(...pSkills)
    commands.push(...pCommands)
    agents.push(...pAgents)
    hooks.push(...pHooks)
    pluginServers.push(...pServers)
  }

  // Same names: the first of each name wins, in the order the lists were built.
  const shadow = (docs: SetupDoc[], label: (d: SetupDoc) => string) => {
    const first = new Map<string, SetupDoc>()
    for (const d of docs) {
      const winner = first.get(d.name)
      if (winner) d.overriddenBy = label(winner)
      else first.set(d.name, d)
    }
  }
  const scopeWord: Record<SetupScope, string> = { managed: 'the managed', user: 'your', project: 'the project', local: 'the local', plugin: 'the plugin', wiki: 'the wiki' }
  shadow(skills, (w) => `${scopeWord[w.scope]} skill ${w.name}`)
  // The wiki's skills load only in chats that pin them (as /wiki:<name>), so they override nothing.
  if (opts.wiki) skills.push(...(await r.skills(path.join(opts.wiki, 'skills'), 'wiki')))
  shadow(agents, (w) => `${scopeWord[w.scope]} agent ${w.name}`)
  shadow(commands, (w) => `${scopeWord[w.scope]} command ${w.name}`)
  const skillNames = new Set(skills.filter((s) => !s.overriddenBy).map((s) => s.name))
  for (const c of commands) if (!c.overriddenBy && skillNames.has(c.name)) c.overriddenBy = `skill ${c.name}`

  // MCP servers.
  const managedMcpFile = path.join(managedDir, 'managed-mcp.json')
  const managedMcp = await r.json(managedMcpFile)
  const serversIn = (data: unknown, scope: SetupScope, file: string) => {
    if (data === undefined) return
    const map = isObj(data) && 'mcpServers' in data ? data.mcpServers : data
    if (!isObj(map)) return r.problem(file, '"mcpServers" is not an object')
    for (const [name, config] of Object.entries(map)) serverDefs.push({ name, scope, config, file })
  }
  if (managedMcp) serversIn(managedMcp.mcpServers ?? {}, 'managed', managedMcpFile)
  if (global.mcpServers !== undefined) serversIn(global.mcpServers, 'user', globalFile)
  if (folder) {
    const projectMcpFile = path.join(folder, '.mcp.json')
    const projectMcp = await r.json(projectMcpFile)
    if (projectMcp) serversIn(projectMcp.mcpServers ?? {}, 'project', projectMcpFile)
    if (projectState?.mcpServers !== undefined) serversIn(projectState.mcpServers, 'local', globalFile)
  }
  serverDefs.push(...pluginServers)

  // Lists from settings (and the folder's state in ~/.claude.json, where claude also keeps them).
  const sources: { path: string; data: Json }[] = [...settings, ...(projectState ? [{ path: globalFile, data: projectState }] : [])]
  const inList = (key: string, name: string) => sources.find((s) => strings(s.data[key]).includes(name))
  const approveAll = sources.find((s) => s.data.enableAllProjectMcpServers === true)
  const denied = settings.flatMap((s) => listOf(s.data.deniedMcpServers).map((rule) => ({ rule, file: s.path })))
  const allowFile = [...settings].reverse().find((s) => Array.isArray(s.data.allowedMcpServers))
  const turnedOff = new Set(strings(projectState?.disabledMcpServers))
  const matches = (rule: unknown, name: string, c: Json) =>
    isObj(rule) &&
    ((typeof rule.serverName === 'string' && rule.serverName === name) ||
      (Array.isArray(rule.serverCommand) && typeof c.command === 'string' && JSON.stringify(rule.serverCommand) === JSON.stringify([c.command, ...strings(c.args)])) ||
      (typeof rule.serverUrl === 'string' && typeof c.url === 'string' && wildcard(rule.serverUrl).test(c.url)))
  // The scopes that beat each one, nearest first.
  const nearer: Record<string, SetupScope[]> = { user: ['local', 'project'], project: ['local'] }

  const mcp: McpEntry[] = []
  for (const def of serverDefs) {
    const c = isObj(def.config) ? def.config : {}
    const rawType = str(c.type)
    const transport: McpTransport =
      rawType === 'streamable-http' || rawType === 'http' ? 'http' : rawType === 'sse' || rawType === 'ws' || rawType === 'stdio' ? rawType : !rawType && str(c.command) ? 'stdio' : 'unknown'
    let state = 'on' as McpState
    let note: string | undefined
    const set = (s: McpState, n: string) => {
      state = s
      note = n
    }
    if (!isObj(def.config)) set('broken', 'Not an object')
    else if (rawType && transport === 'unknown') set('broken', `Unknown type "${rawType}"`)
    else if (transport === 'unknown') set('broken', c.url ? 'A url needs a type (http or sse)' : 'No command or url')
    else if (transport === 'stdio' && !str(c.command)) set('broken', 'No command')
    else if (transport !== 'stdio' && !str(c.url)) set('broken', 'No url')
    else if (managedMcp && def.scope !== 'managed') set('blocked', 'Blocked: managed-mcp.json decides which servers run')
    else if (def.scope !== 'managed' && denied.some((d) => matches(d.rule, def.name, c))) {
      set('blocked', `Blocked by deniedMcpServers in ${r.tilde(denied.find((d) => matches(d.rule, def.name, c))!.file)}`)
    } else if (def.scope !== 'managed' && allowFile && !listOf(allowFile.data.allowedMcpServers).some((rule) => matches(rule, def.name, c))) {
      set('blocked', `Blocked: not in allowedMcpServers in ${r.tilde(allowFile.path)}`)
    } else if (nearer[def.scope]?.some((s) => serverDefs.some((o) => o.scope === s && o.name === def.name))) {
      const by = nearer[def.scope].find((s) => serverDefs.some((o) => o.scope === s && o.name === def.name))!
      set('overridden', `Overridden by the ${by} server of the same name`)
    } else if (turnedOff.has(def.name) || (def.plugin && turnedOff.has(`plugin:${def.plugin}:${def.name}`))) set('off', 'Turned off in /mcp for this folder')
    else if (def.scope === 'project') {
      const rejected = inList('disabledMcpjsonServers', def.name)
      const approved = approveAll ?? inList('enabledMcpjsonServers', def.name)
      if (rejected) set('off', `Rejected in disabledMcpjsonServers in ${r.tilde(rejected.path)}`)
      else if (approved) set('on', `Approved in ${r.tilde(approved.path)}`)
      else set('pending', 'Not approved yet: claude asks before it starts this one')
    }
    const id = `mcp:${def.scope}:${def.plugin ?? ''}:${def.name}`
    const key = def.plugin ? `plugin:${def.plugin}:${def.name}` : def.name
    const fixed: Partial<Record<McpState, string>> = { blocked: 'Blocked by policy', broken: 'Not a usable entry', overridden: 'A nearer server of the same name is used instead' }
    const words: Partial<Record<McpState, string>> = { off: 'off', blocked: 'blocked', broken: 'not a usable entry', overridden: 'overridden, so claude does not start it' }
    const uncheckable = words[state] ? `It is ${words[state]}` : transport === 'ws' ? 'ws servers cannot be checked here' : undefined
    const entry: McpEntry = {
      id,
      name: def.name,
      key,
      scope: def.scope,
      ...(def.plugin ? { plugin: def.plugin } : {}),
      transport,
      ...(str(c.command) ? { command: maskText(String(c.command)) } : {}),
      ...(Array.isArray(c.args) ? { args: maskArgs(c.args) } : {}),
      ...(str(c.url) ? { url: maskUrl(String(c.url)) } : {}),
      env: isObj(c.env) ? Object.entries(c.env).map(([k, v]): [string, string] => [k, maskValue(v)]) : [],
      headers: isObj(c.headers) ? Object.entries(c.headers).map(([k, v]): [string, string] => [k, maskHeader(v)]) : [],
      path: r.tilde(def.file),
      state,
      ...(note ? { note } : {}),
      ...(uncheckable ? { uncheckable } : {}),
      ...(state === 'pending' ? { confirm: true } : {}),
      ...(fixed[state] ? { fixed: fixed[state] } : {}),
    }
    mcp.push(entry)
    r.servers.set(id, { entry, config: c, ...(def.pluginRoot ? { pluginRoot: def.pluginRoot } : {}) })
  }

  // disableAllHooks anywhere that applies turns them all off.
  if (settings.some((s) => s.data.disableAllHooks === true)) for (const h of hooks) h.off = true

  return {
    setup: { folder: folder ? r.tilde(folder) : null, skills, commands, agents, mcp, hooks, plugins: plugins.map((p) => p.entry), problems: r.problems },
    servers: r.servers,
    files: r.files,
  }
}
