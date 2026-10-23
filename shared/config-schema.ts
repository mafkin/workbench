import { z } from 'zod'

// A missing or empty `items:` in hand-written YAML parses as undefined or null.
const list = <T extends z.ZodType>(item: T) =>
  z.array(item).nullish().transform((v) => v ?? [])

const base = {
  id: z.string().optional(),
  label: z.string().trim().min(1, 'Label is required'),
  icon: z.string().optional(),
}

const folderFields = { ...base, type: z.literal('folder'), path: z.string().trim().min(1, 'Path is required') }
export const NoteItem = z.object({ ...base, type: z.literal('note'), path: z.string().trim().min(1, 'Path is required') })
export const LaunchItem = z.object({
  ...base,
  type: z.literal('launch'),
  command: z.string().trim().min(1, 'Command is required'),
  args: list(z.string()),
  cwd: z.string().optional(),
})
export const LinkItem = z.object({ ...base, type: z.literal('link'), url: z.url('Not a valid URL') })
/** The programs a chat can run. */
export const AGENTS = ['claude', 'shell'] as const
export type Agent = (typeof AGENTS)[number]

/** The program behind a chat's `agent:`: `shell`, or claude (itself, or with an agent profile). */
export const chatProgram = (agent: string | undefined): Agent => (agent?.toLowerCase() === 'shell' ? 'shell' : 'claude')

/**
 * A chat: `claude` (or your login shell) in a terminal in the app. `agent` is
 * claude, shell or the name of an agent profile. As a nav entry its folder
 * defaults to home; as a step it is inside the project. `args` come only from
 * the config, never from a request.
 */
export const ChatItem = z.object({
  ...base,
  type: z.literal('chat'),
  agent: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  args: list(z.string()),
})

// Agent profiles: how claude starts, prepared once and picked for a chat.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Claude's permission modes; leaving the field out is claude's own default (it asks). */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  acceptEdits: 'accept edits',
  auto: 'auto',
  plan: 'plan',
  dontAsk: "don't ask",
  bypassPermissions: 'bypass',
}

/**
 * An agent profile. With `agent` (a Claude Code agent, e.g. an orchestrator)
 * the model and effort are left to that agent.
 */
export const AgentProfile = z.object({
  agent: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.enum(EFFORTS, 'Effort must be low, medium, high, xhigh or max').optional(),
  permission: z.enum(PERMISSION_MODES, 'Permission must be acceptEdits, auto, plan, dontAsk or bypassPermissions').optional(),
  /** Added to claude's system prompt. */
  instructions: z.string().optional(),
  /** The first prompt of a new session. */
  prompt: z.string().optional(),
  /** Extra folders claude may use; relative ones are inside the chat's folder. */
  folders: list(z.string()),
  allowedTools: list(z.string()),
  disallowedTools: list(z.string()),
  /** An MCP config file. */
  mcp: z.string().trim().min(1).optional(),
})
export type AgentProfile = z.output<typeof AgentProfile>
/** The fields of an agent profile the app manages, in the order they are written. */
export const AGENT_FIELDS = ['agent', 'model', 'effort', 'permission', 'instructions', 'prompt', 'folders', 'allowedTools', 'disallowedTools', 'mcp'] as const

export const AGENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u
export const AGENT_NAME_RULE = 'An agent profile name is letters, digits, spaces, - and _ (up to 40)'
/** Names a chat's `agent:` already means. */
export const isReservedAgent = (name: string) => AGENTS.includes(name.trim().toLowerCase() as Agent)

// `Reviewer:` with nothing under it is an agent profile with no settings.
const AgentEntry = z.preprocess((v) => v ?? {}, AgentProfile)
const Agents = z
  .record(
    z
      .string()
      .regex(AGENT_NAME, AGENT_NAME_RULE)
      .refine((n) => !isReservedAgent(n), 'claude and shell are built in'),
    AgentEntry,
  )
  .superRefine((agents, ctx) => {
    const seen = new Set<string>()
    for (const name of Object.keys(agents)) {
      if (seen.has(name.toLowerCase())) ctx.addIssue({ code: 'custom', message: `Two agent profiles are named ${name}`, path: [name] })
      seen.add(name.toLowerCase())
    }
  })

/** An agent profile by name, ignoring case: [its name as written, the profile]. */
export function findAgent(profile: { agents?: Record<string, AgentProfile> }, name: string): [string, AgentProfile] | null {
  const want = name.trim().toLowerCase()
  for (const [key, value] of Object.entries(profile.agents ?? {})) if (key.toLowerCase() === want) return [key, value]
  return null
}

/** A short line for menus: `opus · high · plan`, or `agent orchestrator · auto`. */
export function agentSummary(a: AgentProfile): string {
  const parts = a.agent ? [`agent ${a.agent}`] : [a.model, a.effort]
  if (a.permission) parts.push(PERMISSION_LABEL[a.permission])
  return parts.filter(Boolean).join(' · ')
}

// Only as workflow steps: an HTML report shown in its tab, and one file shown large.
const ReportStep = z.object({ ...base, type: z.literal('report'), path: z.string().trim().min(1, 'Path is required') })
const FileStep = z.object({ ...base, type: z.literal('file'), path: z.string().trim().min(1, 'Path is required') })

/**
 * A step in a project's workflow ("assets", "modeling", "design"): a folder, a
 * note, an HTML report, a single file or a chat shown in its tab, or a launcher or web
 * link that opens outside. The fields are those of a nav entry. Relative paths
 * are inside the project folder, which is also a launcher's working folder.
 */
export const StepItem = z.discriminatedUnion('type', [z.object(folderFields), NoteItem, ReportStep, FileStep, ChatItem, LaunchItem, LinkItem])
export const STEP_TYPES = ['folder', 'note', 'report', 'file', 'chat', 'launch', 'link'] as const

export const STATUSES = ['active', 'paused', 'done', 'archived'] as const
export type Status = (typeof STATUSES)[number]

/** The card fields of a project; set from the project header and the nav menu. */
export const CARD_FIELDS = ['description', 'status', 'category', 'pinned', 'agent'] as const

/**
 * A project folder, with its card (description, status, category, pinned) and
 * the agent profile New chat starts there (`agent`, default plain claude).
 * Without `steps:` it uses the profile's `workflow:`; an empty `steps:` means none.
 */
/** A server a project names, for a health check and to show "down" when it is not running. */
export const ServerDecl = z
  .object({
    name: z.string().trim().min(1, 'A server needs a name'),
    port: z.int().min(1).max(65535).optional(),
    url: z.string().regex(/^https?:\/\//, 'A server url starts with http:// or https://').optional(),
  })
  .refine((s) => s.port !== undefined || s.url !== undefined, 'A server needs a port or a url')
export type ServerDecl = z.output<typeof ServerDecl>

export const FolderItem = z.object({
  ...folderFields,
  /** Servers the Servers page checks for this project, besides those it finds running. */
  servers: z.array(ServerDecl).optional(),
  description: z.string().optional(),
  status: z.enum(STATUSES, 'Status must be active, paused, done or archived').optional(),
  category: z.string().trim().min(1).optional(),
  pinned: z.boolean().optional(),
  agent: z.string().trim().min(1).optional(),
  steps: z
    .array(StepItem)
    .nullable()
    .transform((v) => v ?? [])
    .optional(),
})
/** Today's note in the profile's notes folder: `<notes>/<folder>/YYYY-MM-DD.md`. */
export const DailyItem = z.object({ ...base, type: z.literal('daily'), folder: z.string().optional(), template: z.string().optional() })

/**
 * An entry of another drawer shown in this one too: the same entry, found by
 * its drawer, label and (when it has one) path. Renaming or deleting the
 * original updates or removes it.
 */
export const SharedItem = z.object({
  ...base,
  type: z.literal('shared'),
  drawer: z.string().trim().min(1, 'A shared entry names the drawer it comes from'),
  path: z.string().trim().min(1).optional(),
})

export const LeafItem = z.discriminatedUnion('type', [FolderItem, NoteItem, DailyItem, ChatItem, LinkItem, LaunchItem, SharedItem])

/** One level of sub-groups under a heading; a group cannot contain another group. */
export const GroupItem = z.object({
  ...base,
  type: z.literal('group'),
  collapsed: z.boolean().optional(),
  items: list(LeafItem),
})

export const NavItem = z.discriminatedUnion('type', [FolderItem, NoteItem, DailyItem, ChatItem, LinkItem, LaunchItem, SharedItem, GroupItem])

export const Section = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, 'Heading title is required'),
  collapsed: z.boolean().optional(),
  items: list(NavItem),
})

/**
 * A drawer: a nav of its own inside a profile (headings, entries, projects),
 * with a small logo, a shared folder other drawers can use, and the drawers
 * whose shared folders it uses (unknown names are ignored).
 */
export const Drawer = z.object({
  name: z.string().trim().min(1, 'A drawer needs a name').max(40, 'A drawer name is at most 40 characters'),
  /** A 64×64 PNG in the config's logos folder. */
  logo: z.string().trim().min(1).optional(),
  folder: z.string().trim().regex(/^(~|\/)/, 'A drawer folder must start with ~ or /').optional(),
  uses: z.array(z.string().trim().min(1)).optional(),
  sections: list(Section),
})

/**
 * "Open with" (part 10): the program a file opens in, by extension. `args` may
 * use `{file}`, `{dir}` and `{godot}` (the nearest folder up holding a
 * project.godot, else `{dir}`); each becomes one argument, never a shell word.
 */
export const OpenRule = z.object({
  ext: z.array(z.string().trim().min(1).transform((e) => e.replace(/^\./, '').toLowerCase())).min(1, 'Name at least one extension'),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default(['{file}']),
  /** The menu's "Open in <label>"; the command's name by default. */
  label: z.string().trim().min(1).max(40).optional(),
})
export type OpenRule = z.output<typeof OpenRule>

export const Profile = z.object({
  name: z.string().trim().min(1),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Accent must be a #rrggbb colour').default('#7d93ab'),
  /** One of THEMES; another name falls back to slate rather than breaking the file. */
  theme: z.string().trim().min(1).optional(),
  /** `theme` (the theme's own, the default), `none`, or a picture's name in the backgrounds folder. */
  background: z.string().trim().min(1).optional(),
  home: z.string().optional(),
  /** Folder for new notes, daily notes, search and wiki links. */
  notes: z.string().trim().regex(/^(~|\/)/, 'Notes folder must start with ~ or /').optional(),
  /** The steps every project starts with. */
  workflow: list(StepItem),
  /** Colours for project categories; others get one from a palette. */
  categories: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A category colour must be #rrggbb')).optional(),
  /** Agent profiles for chats, by name. */
  agents: Agents.optional(),
  /** Programs for "Open with", before the built-in ones (Blender, Godot). */
  openWith: z.array(OpenRule).optional(),
  /** MCP servers off by default (as /mcp names them: `plugin:<plugin>:<name>`, else the name), turned off in a folder before its first chat. */
  mcpOff: z.array(z.string().trim().min(1)).optional(),
  /** Without drawers, `sections:` is the profile's one drawer; the first drawer change moves it into `drawers:`. */
  drawers: z.array(Drawer).optional(),
  sections: list(Section),
}).superRefine((p, ctx) => {
  if (!p.drawers) return
  if (p.sections.length) ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Use either sections: or drawers:, not both; move the headings into a drawer' })
  const seen = new Set<string>()
  p.drawers.forEach((d, i) => {
    const key = d.name.toLowerCase()
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['drawers', i, 'name'], message: `Two drawers are called ${d.name}` })
    seen.add(key)
  })
})

/** A profile's id is its file name: `profiles/<id>.yaml`. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const PROFILE_ID_RULE = 'A profile id is lower-case letters, digits, - and _ (up to 32), starting with a letter or digit'
/** Accents offered for new profiles and in Profile settings. */
export const ACCENTS = ['#7d93ab', '#8fa58a', '#b39b72', '#a58aa5', '#7fa6a1', '#b38a7d']

export const Settings = z.object({
  activeProfile: z.string().optional(),
  profiles: list(z.string()),
})

export type LeafItem = z.output<typeof LeafItem>
export type StepItem = z.output<typeof StepItem>
export type GroupItem = z.output<typeof GroupItem>
export type NavItem = z.output<typeof NavItem>
export type Section = z.output<typeof Section>
export type SharedItem = z.output<typeof SharedItem>
export type Drawer = z.output<typeof Drawer>
export type Profile = z.output<typeof Profile>
export type Settings = z.output<typeof Settings>
export type ItemType = NavItem['type']
export type StepType = StepItem['type']
/** Nav entry types plus the step-only ones. */
export type AnyType = ItemType | StepType
export type ItemInput = z.input<typeof NavItem> | z.input<typeof StepItem>

export const ITEM_TYPES: ItemType[] = ['folder', 'note', 'daily', 'chat', 'link', 'launch', 'group']

/** The fields each item type owns; editing an item replaces these and keeps any others. */
export const TYPE_FIELDS: Record<AnyType, string[]> = {
  folder: ['path'],
  note: ['path'],
  report: ['path'],
  file: ['path'],
  daily: ['folder', 'template'],
  chat: ['agent', 'path', 'args'],
  link: ['url'],
  launch: ['command', 'args', 'cwd'],
  group: ['collapsed', 'items'],
  shared: ['drawer', 'path'],
}

/** Profile-level keys the app can set, in the order a new key is placed. */
export const PROFILE_FIELDS = ['name', 'accent', 'theme', 'background', 'home', 'notes'] as const

/** The look of a profile: base colours and a background of its own (see src/lib/themes.ts). */
export const THEMES = ['slate', 'fjord', 'moss', 'ember', 'dusk', 'graphite'] as const
export type ThemeId = (typeof THEMES)[number]
export const themeOf = (name: string | undefined): ThemeId => (THEMES as readonly string[]).includes(name ?? '') ? (name as ThemeId) : 'slate'

const index = z.int().nonnegative()

/** Address of a list of items: a heading's list, or a group's list inside a heading, in a drawer (0 when left out). */
export const ListAddr = z.object({ drawer: index.optional(), section: index, group: index.optional() })
export const ItemAddr = ListAddr.extend({ index })
export type ListAddr = z.output<typeof ListAddr>
export type ItemAddr = z.output<typeof ItemAddr>

// Item contents are validated when applied, which gives field-level messages.
const itemInput = z.custom<ItemInput>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), 'Item must be an object')

/** Drawer fields the app sets; `uses` takes a list, the others a string (empty removes it). */
export const DRAWER_FIELDS = ['name', 'logo', 'folder', 'uses'] as const

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addSection'), drawer: index.optional(), title: z.string(), index: index.optional() }),
  z.object({ op: z.literal('renameSection'), drawer: index.optional(), section: index, title: z.string() }),
  z.object({ op: z.literal('deleteSection'), drawer: index.optional(), section: index }),
  z.object({ op: z.literal('moveSection'), drawer: index.optional(), from: index, to: index }),
  z.object({ op: z.literal('addItem'), to: ListAddr, index: index.optional(), item: itemInput }),
  z.object({ op: z.literal('updateItem'), at: ItemAddr, item: itemInput }),
  z.object({ op: z.literal('deleteItem'), at: ItemAddr }),
  z.object({ op: z.literal('moveItem'), from: ItemAddr, to: ListAddr, index }),
  // An empty value removes an optional key (home, notes).
  z.object({ op: z.literal('setProfileField'), key: z.enum(PROFILE_FIELDS), value: z.string() }),
  /** A category's colour in `categories:`; null goes back to the palette's pick. */
  z.object({ op: z.literal('setCategory'), name: z.string().trim().min(1), color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A category colour must be #rrggbb').nullable() }),
  /** Add MCP servers to `mcpOff:` (off) or take them out. */
  z.object({ op: z.literal('setMcpOff'), names: z.array(z.string().trim().min(1)).min(1), off: z.boolean() }),
  // Workflow steps of the folder entry at `at`. The first change to a project
  // using the profile's workflow copies it into the project's own steps.
  z.object({ op: z.literal('addStep'), at: ItemAddr, step: itemInput, index: index.optional() }),
  z.object({ op: z.literal('updateStep'), at: ItemAddr, index, step: itemInput }),
  z.object({ op: z.literal('deleteStep'), at: ItemAddr, index }),
  z.object({ op: z.literal('moveStep'), at: ItemAddr, from: index, to: index }),
  // Back to the profile's workflow.
  z.object({ op: z.literal('resetSteps'), at: ItemAddr }),
  // Make this project's steps the profile's workflow, and use it here too.
  z.object({ op: z.literal('setWorkflow'), at: ItemAddr }),
  // A card field of the project at `at`; null (or an empty description) removes it.
  z.object({ op: z.literal('setCard'), at: ItemAddr, field: z.enum(CARD_FIELDS), value: z.union([z.string(), z.boolean()]).nullable() }),
  // An agent profile: create or update it (and rename it, with everything that
  // names it), or with null delete it, which is refused while something names it.
  z.object({
    op: z.literal('setAgent'),
    name: z.string(),
    agent: z.custom<z.input<typeof AgentProfile>>((v) => typeof v === 'object' && !Array.isArray(v), 'Agent profile must be an object').nullable(),
    rename: z.string().optional(),
  }),
  // Drawers. The first of these on a profile without `drawers:` moves its
  // `sections:` into a first drawer named after the profile.
  z.object({ op: z.literal('addDrawer'), name: z.string() }),
  // A rename updates shared entries and `uses:` that name it.
  z.object({ op: z.literal('setDrawer'), drawer: index, field: z.enum(DRAWER_FIELDS), value: z.union([z.string(), z.array(z.string())]) }),
  // Also removes what other drawers share from it and names of it in `uses:`; the last drawer stays.
  z.object({ op: z.literal('deleteDrawer'), drawer: index }),
  // Show the entry at `at` in drawer `drawer` too (under a heading of the same title), or stop.
  z.object({ op: z.literal('setShared'), at: ItemAddr, drawer: index, on: z.boolean() }),
])
export type Op = z.output<typeof Op>

export interface ConfigError {
  message: string
  line?: number
  col?: number
}

export interface ProfileState {
  id: string
  file: string
  rev: string
  /** Last valid content; kept while the file on disk is broken. */
  profile: Profile | null
  error: ConfigError | null
}

export interface AppState {
  activeProfile: string
  profiles: ProfileState[]
  /** The user's home directory, for comparing `~` paths. */
  home: string
}

/** Expand a leading `~` and `=~/` (as in `--dir=~/x`) to the home directory. */
export function expandHome(value: string, home: string): string {
  return value.replace(/(^|=)~(?=\/|$)/g, (_m, pre: string) => pre + home)
}

/** Stable key for an item address, used for selection and drag ids: `s.i`, `s.g.i`, with `d:` in front past the first drawer. */
export function itemKey(a: ItemAddr): string {
  const key = a.group === undefined ? `${a.section}.${a.index}` : `${a.section}.${a.group}.${a.index}`
  return a.drawer ? `${a.drawer}:${key}` : key
}

// Drawers

/** The profile's drawers; without `drawers:`, one named after the profile holding its `sections:`. */
export function drawersOf(profile: Profile): Drawer[] {
  if (profile.drawers?.length) return profile.drawers
  return [{ name: profile.name, sections: profile.sections }]
}

/** A drawer's name as a folder name: "Game dev" → game-dev. */
export const drawerSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'drawer'

/** Whether the profile has written `drawers:` (else its one drawer is `sections:`). */
export const hasDrawers = (profile: Profile) => !!profile.drawers?.length

export const sectionsOf = (profile: Profile, drawer = 0): Section[] => drawersOf(profile)[drawer]?.sections ?? []

/** Every heading of every drawer. */
export const allSections = (profile: Profile): Section[] => drawersOf(profile).flatMap((d) => d.sections)

/** A drawer's index by name, ignoring case; -1 when there is none. */
export const drawerIndex = (profile: Profile, name: string) => drawersOf(profile).findIndex((d) => d.name.toLowerCase() === name.toLowerCase())

/** Every entry with its address, group children after their group, drawer by drawer. */
export function walkItems(profile: Profile): { addr: ItemAddr; item: NavItem }[] {
  const out: { addr: ItemAddr; item: NavItem }[] = []
  drawersOf(profile).forEach((d, drawer) =>
    d.sections.forEach((s, section) =>
      s.items.forEach((item, index) => {
        const at = drawer ? { drawer, section, index } : { section, index }
        out.push({ addr: at, item })
        if (item.type === 'group') item.items.forEach((child, i) => out.push({ addr: { ...at, group: index, index: i }, item: child }))
      }),
    ),
  )
  return out
}

/** Whether `item` is the original a shared entry points at. */
export const isOriginalOf = (ref: SharedItem, item: NavItem) =>
  item.type !== 'shared' && item.type !== 'group' && item.label === ref.label && (ref.path === undefined || ('path' in item && item.path === ref.path))

/** The entry a shared entry points at, or null when it is gone. */
export function findShared(profile: Profile, ref: SharedItem): { addr: ItemAddr; item: NavItem } | null {
  const d = drawerIndex(profile, ref.drawer)
  if (d < 0) return null
  return walkItems(profile).find((e) => (e.addr.drawer ?? 0) === d && isOriginalOf(ref, e.item)) ?? null
}

/** The entry at an address, following a shared entry to its original; null when either is missing. */
export function entryAt(profile: Profile, a: ItemAddr): { addr: ItemAddr; item: NavItem } | null {
  const item = getItem(profile, a)
  if (!item) return null
  return item.type === 'shared' ? findShared(profile, item) : { addr: a, item }
}

export const sameAddr = (a: ItemAddr, b: ItemAddr) => (a.drawer ?? 0) === (b.drawer ?? 0) && a.section === b.section && a.group === b.group && a.index === b.index

/** The shared entries in other drawers that point at the entry at `a`. */
export function sharedRefs(profile: Profile, a: ItemAddr): { addr: ItemAddr; item: SharedItem }[] {
  const out: { addr: ItemAddr; item: SharedItem }[] = []
  for (const e of walkItems(profile)) {
    if (e.item.type !== 'shared') continue
    const original = findShared(profile, e.item)
    if (original && sameAddr(original.addr, a)) out.push({ addr: e.addr, item: e.item })
  }
  return out
}

export function getItem(profile: Profile, a: ItemAddr): NavItem | undefined {
  const section = sectionsOf(profile, a.drawer ?? 0)[a.section]
  if (!section) return undefined
  if (a.group === undefined) return section.items[a.index]
  const group = section.items[a.group]
  return group?.type === 'group' ? group.items[a.index] : undefined
}

/** Shorten a path under the home directory to `~/…`, the form used in the config. */
export function displayPath(abs: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  if (abs === h) return '~'
  return abs.startsWith(`${h}/`) ? `~${abs.slice(h.length)}` : abs
}

// Notes (part 2)

export const NOTE_EXT = /\.(md|markdown)$/i

export interface NoteFile {
  /** `~/…` form; the key the UI uses for a note. */
  path: string
  text: string
  rev: string
  mtime: number
}

export interface NoteSummary {
  path: string
  /** File name without the extension; what `[[wiki links]]` match. */
  name: string
  /** Path inside the notes folder, with extension, or null for a note entry outside it. */
  rel: string | null
  mtime: number
}

export interface SearchLine {
  line: number
  text: string
  /** [start, end) offsets of matches in `text`. */
  ranges: [number, number][]
}

export interface SearchHit extends NoteSummary {
  title: boolean
  lines: SearchLine[]
}

/** File name for a note title: `Deploy plan` -> `Deploy plan.md`. Null when nothing usable is left. */
export function noteFileName(title: string): string | null {
  const name = title
    .replace(/[/\\]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.(md|markdown)$/i, '')
    .trim()
  if (!name) return null
  return `${name.slice(0, 120)}.md`
}

/** Local date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Fill `{{date}}` and `{{title}}` in a note template. */
export function fillTemplate(template: string, vars: { date: string; title: string }): string {
  return template.replace(/\{\{\s*(date|title)\s*\}\}/g, (_m, key: 'date' | 'title') => vars[key])
}

/** Join a notes-folder-relative path onto the notes folder, keeping `~` form. */
export function joinNotes(root: string, rel: string): string {
  const clean = rel.replace(/^\/+/, '').replace(/\/+$/, '')
  return clean ? `${root.replace(/\/+$/, '')}/${clean}` : root
}

// Workflow steps

/** A project's steps: its own, or the profile's workflow. */
export function stepsOf(profile: Profile, item: NavItem): StepItem[] {
  if (item.type !== 'folder') return []
  return item.steps ?? profile.workflow
}

/** Collapse `.` and `..` in a `~/…` or absolute path; a `..` that cannot be collapsed is kept. */
export function normalizePath(p: string): string {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    const last = out[out.length - 1]
    if (part === '..' && last !== undefined && last !== '..' && last !== '~') out.pop()
    else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

/** A step's path: `~/…` and `/…` as they are, anything else inside the project folder. */
export function stepPath(project: string, p: string): string {
  return normalizePath(/^(~|\/)/.test(p) ? p : `${project}/${p}`)
}

/** A step with its paths resolved; a launcher runs in the project folder unless it says otherwise. */
export function stepEntry(project: string, step: StepItem): StepItem {
  if (step.type === 'launch') return { ...step, cwd: stepPath(project, step.cwd ?? '.') }
  if (step.type === 'link') return step
  if (step.type === 'chat') return { ...step, path: stepPath(project, step.path ?? '.') }
  return { ...step, path: stepPath(project, step.path) }
}

const parentPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '.')

// Tame colours for categories without their own, picked steadily by name.
export const CATEGORY_PALETTE = ['#7d93ab', '#8fa58a', '#b39b78', '#a38aa8', '#7fa3a0', '#b58a86', '#9a9fb0']

export function categoryColor(profile: Profile, name: string): string {
  const own = profile.categories?.[name]
  if (own) return own
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length]
}

/** Categories in use by the profile's projects, plus those with a colour, sorted. */
export function categoriesOf(profile: Profile): string[] {
  const out = new Set(Object.keys(profile.categories ?? {}))
  const visit = (item: NavItem) => {
    if (item.type === 'folder' && item.category) out.add(item.category)
    if (item.type === 'group') item.items.forEach(visit)
  }
  for (const s of allSections(profile)) s.items.forEach(visit)
  return [...out].sort((a, b) => a.localeCompare(b))
}

// File browser (part 3)

/**
 * Folders the file browser may open, as written in the config: home, the notes
 * folder, every folder entry and every drawer's shared folder. The service resolves and enforces them; the UI
 * shows them as chips.
 */
export function folderRoots(profile: Profile): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  if (profile.home) out.push({ label: 'Home', path: profile.home })
  if (profile.notes) out.push({ label: 'Notes', path: profile.notes })
  const project = (item: NavItem) => {
    if (item.type !== 'folder') return
    out.push({ label: item.label, path: item.path })
    // A step can sit outside its project, e.g. a shared assets folder; a report
    // or a file needs its own folder (a report loads the files next to it).
    for (const step of stepsOf(profile, item)) {
      const label = `${item.label} › ${step.label}`
      if (step.type === 'folder') out.push({ label, path: stepPath(item.path, step.path) })
      if (step.type === 'report' || step.type === 'file') out.push({ label, path: stepPath(item.path, parentPath(step.path)) })
    }
  }
  for (const section of allSections(profile)) {
    for (const item of section.items) {
      project(item)
      if (item.type === 'group') item.items.forEach(project)
    }
  }
  for (const d of profile.drawers ?? []) if (d.folder) out.push({ label: `${d.name} (shared folder)`, path: d.folder })
  return out
}

export interface FileEntry {
  name: string
  /** `~/…` form, like note paths. */
  path: string
  kind: 'dir' | 'file' | 'other'
  /** A symlink; `kind` is what it points to. */
  link: boolean
  size: number
  mtime: number
  /** A dotfile. */
  hidden: boolean
  /** Excluded by .gitignore. */
  ignored: boolean
}

export interface FileListing {
  path: string
  entries: FileEntry[]
}

export interface FileText {
  text: string
  /** Only the first 200 KB was read. */
  truncated: boolean
  binary: boolean
  size: number
}

export const FileOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), path: z.string(), name: z.string() }),
  z.object({ op: z.literal('mkdir'), dir: z.string(), name: z.string() }),
  z.object({ op: z.literal('touch'), dir: z.string(), name: z.string() }),
  z.object({ op: z.literal('move'), paths: z.array(z.string()).min(1), to: z.string() }),
  z.object({ op: z.literal('trash'), paths: z.array(z.string()).min(1) }),
  /** Into `to`, under a free name (`x copy.txt`) when the name is taken or it is the same folder. */
  z.object({ op: z.literal('copy'), paths: z.array(z.string()).min(1), to: z.string() }),
  /** Put trashed files back where they were (Undo for Trash). */
  z.object({ op: z.literal('restore'), paths: z.array(z.string()).min(1) }),
])
export type FileOp = z.output<typeof FileOp>

export interface MoveResult {
  moved: { from: string; to: string }[]
  skipped: { path: string; reason: string }[]
}

export interface CopyResult {
  copied: { from: string; to: string }[]
  skipped: { path: string; reason: string }[]
}

export interface RestoreResult {
  restored: string[]
  skipped: { path: string; reason: string }[]
}

export type FileOpResult = { path: string } | MoveResult | { trashed: string[] } | CopyResult | RestoreResult

/** A folder's size, added up on request; `complete` is false when the count stopped early. */
export interface FolderSize {
  bytes: number
  files: number
  complete: boolean
}

/** Names matching a search below a folder, closed folders included. */
export interface FileFind {
  hits: FileEntry[]
  complete: boolean
}

// Servers running in projects (part 8)

export interface ServerHealth {
  /** up: answers HTTP; listening: takes connections but not HTTP; down: nothing there. */
  state: 'up' | 'listening' | 'down'
  code?: number
  text: string
}

export interface ServerRow {
  /** Stable within a project: the port, or the declared name. */
  id: string
  /** A declared server's name. */
  name?: string
  declared: boolean
  port: number | null
  pid?: number
  /** The process name and command line. */
  process?: string
  command?: string
  /** Where it runs, `~/…`. */
  cwd?: string
  /** Start time, ms since the epoch. */
  started?: number
  url: string | null
  health: ServerHealth
}

export interface ProjectServers {
  label: string
  path: string
  rows: ServerRow[]
}

export interface ServersScan {
  at: number
  projects: ProjectServers[]
}

// Agent chats (part 5)

export type ChatState = 'running' | 'exited' | 'stopped'

/** A chat as the UI sees it; the service keeps the program and its screen. */
export interface Chat {
  id: string
  profile: string
  /** Where its tab shows: `project:<path>` for a project, or a chat entry's slot. */
  host: string
  /** The chat step or chat entry this chat belongs to; null for one started with New chat. */
  slot: string | null
  agent: Agent
  /** The agent profile it started with; null for plain claude or the shell. */
  agentProfile: string | null
  /** Started with permissions bypassed. */
  bypass: boolean
  /** Working folder, `~/…` form. */
  cwd: string
  /** Your name for it. */
  label: string | null
  /** The terminal title the program set. */
  title: string | null
  color: string | null
  pinned: boolean
  /** Claude's session id; resumes with `claude --resume`. */
  session: string | null
  state: ChatState
  exitCode: number | null
  /** Rang the bell, or went quiet after working, and nobody has looked since. */
  attention: boolean
  /** Your prompts in the Claude session, when counted. */
  messages: number
  createdAt: number
  /** Started with the profile's context folders (--add-dir and appended instructions). */
  context: boolean
}

/** A profile's context folders, inside its notes folder; set up once `context/` exists. */
export const CONTEXT_FOLDERS = ['context', 'knowledge', 'processes', 'inbox'] as const
export type ContextFolder = (typeof CONTEXT_FOLDERS)[number]
export const CONTEXT_LABEL: Record<ContextFolder, string> = { context: 'Context', knowledge: 'Knowledge', processes: 'Processes', inbox: 'Inbox' }

export interface ContextStatus {
  /** The profile's notes folder as written, or null without one. */
  notes: string | null
  /** `context/` exists: chats get the context. */
  ready: boolean
  /** In `~/…` form; empty without a notes folder. */
  folders: { name: ContextFolder; path: string; exists: boolean }[]
  /** Things in the inbox (dotfiles not counted). */
  inbox: number
}

/** A past Claude session in a folder, from claude's own transcripts. */
export interface ClaudeSession {
  id: string
  /** `~/…` form. */
  cwd: string
  title: string
  mtime: number
}

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Colours a chat can be given; the same tame palette as categories. */
export const CHAT_COLORS = CATEGORY_PALETTE

/** Keys are made from paths and labels, not nav addresses, so moving an entry keeps its chats. */
export const projectHost = (projectPath: string) => `project:${normalizePath(projectPath)}`
export const stepSlot = (projectPath: string, label: string) => `step:${normalizePath(projectPath)}|${label}`
export const entrySlot = (item: { label: string; path?: string }) => `entry:${normalizePath(item.path ?? '~')}|${item.label}`

/** What a chat tab is called: your name, else the program's title without its spinner, else its agent profile or program. */
export function chatName(chat: Pick<Chat, 'label' | 'title' | 'agent'> & { agentProfile?: string | null }): string {
  const title = chat.title?.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  return chat.label || title || chat.agentProfile || (chat.agent === 'shell' ? 'Shell' : 'Claude')
}
