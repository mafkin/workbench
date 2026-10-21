import { z } from 'zod'

// A missing or empty `items:` in hand-written YAML parses as undefined or null.
const list = <T extends z.ZodType>(item: T) =>
  z.array(item).nullish().transform((v) => v ?? [])

const base = {
  id: z.string().optional(),
  label: z.string().trim().min(1, 'Label is required'),
  icon: z.string().optional(),
}

export const FolderItem = z.object({ ...base, type: z.literal('folder'), path: z.string().trim().min(1, 'Path is required') })
export const NoteItem = z.object({ ...base, type: z.literal('note'), path: z.string().trim().min(1, 'Path is required') })
export const ProjectItem = z.object({ ...base, type: z.literal('project'), project: z.string().trim().min(1, 'Project id is required') })
export const LinkItem = z.object({ ...base, type: z.literal('link'), url: z.url('Not a valid URL') })
/** Today's note in the profile's notes folder: `<notes>/<folder>/YYYY-MM-DD.md`. */
export const DailyItem = z.object({ ...base, type: z.literal('daily'), folder: z.string().optional(), template: z.string().optional() })
export const LaunchItem = z.object({
  ...base,
  type: z.literal('launch'),
  command: z.string().trim().min(1, 'Command is required'),
  args: list(z.string()),
  cwd: z.string().optional(),
})

export const LeafItem = z.discriminatedUnion('type', [FolderItem, NoteItem, DailyItem, ProjectItem, LinkItem, LaunchItem])

/** One level of sub-groups under a heading; a group cannot contain another group. */
export const GroupItem = z.object({
  ...base,
  type: z.literal('group'),
  collapsed: z.boolean().optional(),
  items: list(LeafItem),
})

export const NavItem = z.discriminatedUnion('type', [FolderItem, NoteItem, DailyItem, ProjectItem, LinkItem, LaunchItem, GroupItem])

export const Section = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, 'Heading title is required'),
  collapsed: z.boolean().optional(),
  items: list(NavItem),
})

export const Profile = z.object({
  name: z.string().trim().min(1),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Accent must be a #rrggbb colour').default('#7d93ab'),
  home: z.string().optional(),
  /** Folder for new notes, daily notes, search and wiki links. */
  notes: z.string().trim().regex(/^(~|\/)/, 'Notes folder must start with ~ or /').optional(),
  sections: list(Section),
})

export const Settings = z.object({
  activeProfile: z.string().optional(),
  profiles: list(z.string()),
})

export type LeafItem = z.output<typeof LeafItem>
export type GroupItem = z.output<typeof GroupItem>
export type NavItem = z.output<typeof NavItem>
export type Section = z.output<typeof Section>
export type Profile = z.output<typeof Profile>
export type Settings = z.output<typeof Settings>
export type ItemType = NavItem['type']
export type ItemInput = z.input<typeof NavItem>

export const ITEM_TYPES: ItemType[] = ['folder', 'note', 'daily', 'project', 'link', 'launch', 'group']

/** The fields each item type owns; editing an item replaces these and keeps any others. */
export const TYPE_FIELDS: Record<ItemType, string[]> = {
  folder: ['path'],
  note: ['path'],
  daily: ['folder', 'template'],
  project: ['project'],
  link: ['url'],
  launch: ['command', 'args', 'cwd'],
  group: ['collapsed', 'items'],
}

/** Profile-level keys the app can set, in the order a new key is placed. */
export const PROFILE_FIELDS = ['name', 'accent', 'home', 'notes'] as const

const index = z.int().nonnegative()

/** Address of a list of items: a heading's list, or a group's list inside a heading. */
export const ListAddr = z.object({ section: index, group: index.optional() })
export const ItemAddr = ListAddr.extend({ index })
export type ListAddr = z.output<typeof ListAddr>
export type ItemAddr = z.output<typeof ItemAddr>

// Item contents are validated when applied, which gives field-level messages.
const itemInput = z.custom<ItemInput>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), 'Item must be an object')

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addSection'), title: z.string(), index: index.optional() }),
  z.object({ op: z.literal('renameSection'), section: index, title: z.string() }),
  z.object({ op: z.literal('deleteSection'), section: index }),
  z.object({ op: z.literal('moveSection'), from: index, to: index }),
  z.object({ op: z.literal('addItem'), to: ListAddr, index: index.optional(), item: itemInput }),
  z.object({ op: z.literal('updateItem'), at: ItemAddr, item: itemInput }),
  z.object({ op: z.literal('deleteItem'), at: ItemAddr }),
  z.object({ op: z.literal('moveItem'), from: ItemAddr, to: ListAddr, index }),
  // An empty value removes an optional key (home, notes).
  z.object({ op: z.literal('setProfileField'), key: z.enum(PROFILE_FIELDS), value: z.string() }),
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

/** Stable key for an item address, used for selection and drag ids. */
export function itemKey(a: ItemAddr): string {
  return a.group === undefined ? `${a.section}.${a.index}` : `${a.section}.${a.group}.${a.index}`
}

export function getItem(profile: Profile, a: ItemAddr): NavItem | undefined {
  const section = profile.sections[a.section]
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
