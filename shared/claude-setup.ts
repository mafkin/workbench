// What claude loads on this machine, as the Claude setup page shows it: skills,
// commands, agents, MCP servers, hooks and plugins, each with the scope it
// comes from. Only MCP servers change (switched on or off, like /mcp); the
// service masks every secret value before it sends any of this to the browser.

/** Where something comes from. Plugin items also name their plugin. */
export type SetupScope = 'managed' | 'user' | 'project' | 'local' | 'plugin' | 'wiki'

export const SCOPES: SetupScope[] = ['project', 'local', 'user', 'managed', 'plugin', 'wiki']

export const SCOPE_LABEL: Record<SetupScope, string> = {
  project: 'Project',
  local: 'Local',
  user: 'Yours',
  managed: 'Managed',
  plugin: 'Plugin',
  wiki: 'Wiki',
}

export type DocKind = 'skill' | 'agent' | 'command'

/** A skill, agent or command: a Markdown file with frontmatter. */
export interface SetupDoc {
  id: string
  kind: DocKind
  /** As claude knows it: `analyze`, `data:analyze`, `frontend:component`. */
  name: string
  description: string
  scope: SetupScope
  plugin?: string
  /** Synced from claude.ai. */
  synced?: boolean
  /** The file, with the home folder as `~`. */
  path: string
  /** The other frontmatter fields, as text. */
  fields: [string, string][]
  /** What claude uses instead, when something else has the same name. */
  overriddenBy?: string
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'unknown'

/**
 * on: claude starts it. off: turned off (settings or /mcp). pending: a project
 * server claude will ask about. blocked: managed policy. overridden: the same
 * name in a nearer scope wins. broken: not a usable entry.
 */
export type McpState = 'on' | 'off' | 'pending' | 'blocked' | 'overridden' | 'broken'

export interface McpEntry {
  id: string
  name: string
  /** The name /mcp turns it off by: `plugin:<plugin>:<name>` for a plugin's server, else the name. */
  key: string
  scope: SetupScope
  plugin?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  /** Values are masked. */
  env: [string, string][]
  headers: [string, string][]
  /** The file it is in. */
  path: string
  state: McpState
  /** Why it is in that state. */
  note?: string
  /** Why it cannot be checked, when it cannot. */
  uncheckable?: string
  /** A project server not approved yet: checking runs a command from the folder, so ask first. */
  confirm?: boolean
  /** Why it cannot be switched on or off, when it cannot. */
  fixed?: string
}

export interface HookEntry {
  id: string
  event: string
  /** Empty matches everything. */
  matcher: string
  /** command, http, prompt, agent or mcp_tool. */
  type: string
  /** The command, URL, tool or prompt, masked. */
  run: string
  timeout?: number
  scope: SetupScope
  plugin?: string
  path: string
  /** `disableAllHooks` is set where this applies. */
  off?: boolean
}

export interface PluginEntry {
  /** `name@marketplace`. */
  id: string
  name: string
  marketplace: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  /** Where the marketplace comes from (a repo, a URL or a folder). */
  source?: string
  enabled: boolean
  /** The settings file that turns it on or off. */
  setIn?: string
  /** Its folder on disk. */
  path?: string
  /** Enabled but its files are not there. */
  missing?: boolean
  synced?: boolean
  provides: { skills: number; commands: number; agents: number; hooks: number; mcp: number }
}

export interface SetupProblem {
  path: string
  message: string
}

export interface ClaudeSetup {
  /** The folder the setup is for (project and local items), or null for everywhere. */
  folder: string | null
  skills: SetupDoc[]
  commands: SetupDoc[]
  agents: SetupDoc[]
  mcp: McpEntry[]
  hooks: HookEntry[]
  plugins: PluginEntry[]
  problems: SetupProblem[]
  /** The skills pinned for chats here (part 12): by the profile, the drawer, the page; `missing` names nothing resolves. */
  pinned?: { profile: string[]; drawer: string[]; page: string[]; missing: string[] }
}

export interface McpTool {
  name: string
  description?: string
}

/** The result of starting a server, listing its tools and stopping it. */
export interface McpCheck {
  ok: boolean
  ms: number
  protocolVersion?: string
  /** Its name and version, as it reports them. */
  server?: string
  tools: McpTool[]
  error?: string
  /** It wants a sign-in, which claude does (/mcp). */
  needsAuth?: boolean
  /** The end of its stderr, masked. */
  log?: string
}
