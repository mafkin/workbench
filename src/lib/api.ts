import type {
  AppState,
  Chat,
  ClaudeSession,
  ContextStatus,
  FileFind,
  FileListing,
  FileOp,
  FileOpResult,
  FileText,
  FolderSize,
  ItemAddr,
  NoteFile,
  NoteSummary,
  Op,
  SearchHit,
  ServersScan,
} from '../../shared/config-schema.ts'
import type { ClaudeSetup, McpCheck } from '../../shared/claude-setup.ts'
import type { Branch, Commit, CommitDetail, DiscardResult, GitDiff, GitMark, GitStatus } from '../../shared/git.ts'

export class ApiError extends Error {
  status: number
  /** The rest of the error body, e.g. the current rev on a conflict. */
  data: Record<string, unknown>
  constructor(message: string, status: number, data: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.data = data
  }
}

/** Every API call carries X-Workbench; the service refuses calls without it. */
export async function api<T>(url: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-workbench': '1',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    keepalive: init.keepalive,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const { error, ...rest } = data
    throw new ApiError(error ?? res.statusText, res.status, rest)
  }
  return data as T
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

export const getState = () => api<AppState>('/api/state')
export const applyOps = (profile: string, rev: string, ops: Op[]) =>
  api<{ rev: string }>(`/api/profiles/${encodeURIComponent(profile)}/ops`, { body: { rev, ops } })
export const undo = (profile: string, rev: string) =>
  api<{ rev: string }>(`/api/profiles/${encodeURIComponent(profile)}/undo`, { body: { rev } })
export const setActive = (profile: string) => api('/api/active', { body: { profile } })
/** A new profile: blank, or a copy of another (its headings and workflow) under a new name. */
export const createProfile = (id: string, name: string, copyFrom?: string, wiki?: string) => api<{ id: string }>('/api/profiles', { body: { id, name, copyFrom, wiki } })
/** Profiles still in YAML become wikis. */
export const migrate = () => api<{ moved: string[] }>('/api/migrate', { body: {} })
/** The profile's file goes to the Trash. */
export const removeProfile = (id: string) => api(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** Open an entry, or with `step`, start a project's launcher step. */
export const openEntry = (profile: string, rev: string, at: ItemAddr, step?: number) => api('/api/open', { body: { profile, rev, at, step } })
export const stat = (path: string) =>
  api<{ exists: boolean; kind: 'dir' | 'file' | null }>(`/api/stat?path=${encodeURIComponent(path)}`)

export const readNote = (profile: string, path: string) => api<NoteFile>(`/api/notes/file?${query({ profile, path })}`)
/**
 * `rev: null` creates the file and fails with 409 if it exists. `keepalive` lets a save finish while the
 * page closes; browsers cap such a request at 64 KB, so a larger note is sent as a normal request.
 */
export const writeNote = (profile: string, path: string, rev: string | null, text: string, keepalive = false) =>
  api<Omit<NoteFile, 'text'>>('/api/notes/file', {
    body: { profile, path, rev, text },
    keepalive: keepalive && text.length < 60_000,
  })
export const listNotes = (profile: string) => api<NoteSummary[]>(`/api/notes/list?${query({ profile })}`)
/** Notes linking to this one, with the lines that do. */
export const backlinks = (profile: string, path: string) => api<SearchHit[]>(`/api/notes/backlinks?${query({ profile, path })}`)
/** Rename a note in the notes folder; links to it are rewritten. */
export const renameNote = (profile: string, path: string, name: string) =>
  api<{ path: string; files: number; links: number }>('/api/notes/rename', { body: { profile, path, name } })
/** `<notes>/templates/<name>.md`, or null. */
export const noteTemplate = (profile: string, name: string) => api<{ text: string | null }>(`/api/notes/template?${query({ profile, name })}`)
export const searchNotes = (profile: string, q: string) => api<SearchHit[]>(`/api/notes/search?${query({ profile, q })}`)

export const listFiles = (profile: string, path: string) => api<FileListing>(`/api/files/list?${query({ profile, path })}`)
export const fileText = (profile: string, path: string) => api<FileText>(`/api/files/text?${query({ profile, path })}`)
/** A short-lived URL for media elements, which cannot send the X-Workbench header. */
/** With `folder`, an HTML report's or a 3D model's URL also serves the files next to it. */
export const fileTicket = (profile: string, path: string, folder = false) =>
  api<{ url: string }>('/api/files/ticket', { body: { profile, path, folder } })
export const fileOp = <T extends FileOpResult = FileOpResult>(profile: string, op: FileOp) =>
  api<T>('/api/files/op', { body: { profile, op } })
export const openFile = (profile: string, path: string) => api('/api/files/open', { body: { profile, path } })
/** The program a file opens in (the profile's openWith:, or Blender and Godot when installed); null for the default app. */
export const openWithLabel = (profile: string, path: string) => api<{ label: string | null }>(`/api/files/open-with?${query({ profile, path })}`)
export const openWith = (profile: string, path: string) => api<{ label: string }>('/api/files/open-with', { body: { profile, path } })
/** When a project's folder was made and last worked on (git, else its files). */
export const projectDates = (profile: string, path: string) =>
  api<{ created: number | null; updated: number | null; source: 'git' | 'files' }>(`/api/projects/dates?${query({ profile, path })}`)
/** A folder's size, added up on request. */
export const folderSize = (profile: string, path: string) => api<FolderSize>(`/api/files/size?${query({ profile, path })}`)
/** Names containing `q` below a folder, closed folders included. */
export const findFiles = (profile: string, path: string, q: string, hidden: boolean) =>
  api<FileFind>(`/api/files/find?${query({ profile, path, q, ...(hidden ? { hidden: '1' } : {}) })}`)
/** A file dropped from the desktop, streamed into `dir`; the service picks a free name. */
export async function uploadFile(profile: string, dir: string, file: File): Promise<{ path: string }> {
  const res = await fetch(`/api/files/upload?${query({ profile, dir, name: file.name })}`, {
    method: 'POST',
    headers: { 'x-workbench': '1', 'content-type': 'application/octet-stream' },
    body: file,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status, data)
  return data
}

// Chats: started from an entry or step by address; the service picks the program.
export interface ChatStart {
  at: ItemAddr
  /** A chat step of the project at `at`. */
  step?: number
  /** New chat in a project: claude, shell or an agent profile (default the project's), in `path` (default the project folder). */
  agent?: string
  path?: string
  /** A Claude session from History. */
  resume?: string
}
export const listChats = (profile: string) => api<Chat[]>(`/api/chats?${query({ profile })}`)
export const startChat = (profile: string, rev: string, req: ChatStart) => api<Chat>('/api/chats', { body: { profile, rev, ...req } })
export const updateChat = (id: string, patch: { label?: string | null; color?: string | null; pinned?: boolean }) =>
  api<Chat>(`/api/chats/${id}`, { method: 'PATCH', body: patch })
export const restartChat = (id: string, fresh: boolean) => api<Chat>(`/api/chats/${id}/start`, { body: { fresh } })
export const seenChat = (id: string) => api(`/api/chats/${id}/seen`, { body: {} })
export const handoffChat = (id: string) => api<Chat>(`/api/chats/${id}/handoff`, { body: {} })
export const closeChat = (id: string) => api(`/api/chats/${id}`, { method: 'DELETE' })
export const chatHistory = (profile: string, path: string) => api<ClaudeSession[]>(`/api/chats/history?${query({ profile, path })}`)
/** Claude Code agents an agent profile can name, from yours and the folder's `.claude/agents`. */
export const claudeAgents = (profile: string, path: string) => api<string[]>(`/api/chats/claude-agents?${query({ profile, path })}`)
/** The token a chat's terminal socket needs; new each time the service starts. */
export const chatToken = () => api<{ token: string }>('/api/chats/token').then((r) => r.token)

// Servers running in the profile's projects.
export const servers = (profile: string) => api<ServersScan>(`/api/servers?${query({ profile })}`)
/** SIGTERM to a server the scan lists; the service checks it again first. */
export const stopServer = (profile: string, pid: number, port: number) => api('/api/servers/stop', { body: { profile, pid, port } })

// Context folders: set up on request; files are copied into the inbox, never overwriting.
export const contextStatus = (profile: string) => api<ContextStatus>(`/api/context?${query({ profile })}`)
export const setupContext = (profile: string) => api<ContextStatus>('/api/context/setup', { body: { profile } })
export const sendToInbox = (profile: string, path: string) => api<{ path: string }>('/api/context/inbox', { body: { profile, path } })

// Claude setup, masked. `folder` adds that folder's project and local items.
const inFolder = (folder: string | null): Record<string, string> => (folder ? { path: folder } : {})
export const claudeSetup = (profile: string, folder: string | null) => api<ClaudeSetup>(`/api/claude/setup?${query({ profile, ...inFolder(folder) })}`)
export const claudeDoc = (profile: string, folder: string | null, id: string) =>
  api<{ body: string }>(`/api/claude/doc?${query({ profile, id, ...inFolder(folder) })}`)
/** Start a server (or connect), list its tools and stop it. `confirm` for a project server claude has not approved. */
export const checkMcp = (profile: string, folder: string | null, id: string, confirm = false) =>
  api<McpCheck>('/api/claude/check', { body: { profile, id, confirm, ...inFolder(folder) } })
/** MCP servers (by their /mcp names) on or off in a folder, like /mcp; without a folder, the profile's defaults (needs its rev). */
export const switchMcp = (profile: string, folder: string | null, keys: string[], on: boolean, rev?: string) =>
  api<{ setup: ClaudeSetup; rev?: string }>('/api/claude/mcp', { body: { profile, keys, on, ...(folder ? { path: folder } : { rev }) } })

/** Make <notes or home>/drawers/<name> for a drawer; returns it for `folder:`. */
export const drawerFolder = (profile: string, name: string) => api<{ folder: string }>('/api/drawers/folder', { body: { profile, name } })

// Background pictures: copies in the config folder, chosen per profile.
export const listBackgrounds = () => api<string[]>('/api/backgrounds')
export const addBackground = (profile: string, path: string) => api<{ name: string }>('/api/backgrounds', { body: { profile, path } })
export const deleteBackground = (name: string) => api(`/api/backgrounds/${encodeURIComponent(name)}`, { method: 'DELETE' })
/** A picture's bytes, for a blob URL: CSS cannot send the X-Workbench header. */
export async function backgroundImage(name: string): Promise<Blob> {
  const res = await fetch(`/api/backgrounds/${encodeURIComponent(name)}`, { headers: { 'x-workbench': '1' } })
  if (!res.ok) throw new ApiError(res.statusText, res.status)
  return res.blob()
}

/** Images in notes go through fetch, because an <img> cannot send the X-Workbench header. */
export async function noteImage(profile: string, path: string): Promise<Blob> {
  const res = await fetch(`/api/notes/asset?${query({ profile, path })}`, { headers: { 'x-workbench': '1' } })
  if (!res.ok) throw new ApiError(res.statusText, res.status)
  return res.blob()
}

// Git per project: `path` is the project's folder entry path, as in the config.
type GitAt = { profile: string; path: string }
type GitChange = { files?: string[]; all?: boolean; hunk?: { file: string; id: string } }
/** A change answers with what it did and the status it left. */
type GitDone<T = object> = T & { status: GitStatus }
export const git = {
  marks: (profile: string) => api<GitMark[]>(`/api/git/marks?${query({ profile })}`),
  status: (at: GitAt) => api<GitStatus>(`/api/git/status?${query(at)}`),
  diff: (at: GitAt, file: string, staged: boolean) => api<GitDiff>(`/api/git/diff?${query({ ...at, file, staged: staged ? '1' : '0' })}`),
  stage: (at: GitAt, change: GitChange) => api<GitDone>('/api/git/stage', { body: { ...at, ...change } }),
  unstage: (at: GitAt, change: GitChange) => api<GitDone>('/api/git/unstage', { body: { ...at, ...change } }),
  discard: (at: GitAt, change: GitChange) => api<GitDone<DiscardResult>>('/api/git/discard', { body: { ...at, ...change } }),
  undo: (at: GitAt, undo: string) => api<GitDone<{ restored: string[]; skipped: { path: string; reason: string }[] }>>('/api/git/undo', { body: { ...at, undo } }),
  commit: (at: GitAt, message: string, amend: boolean) => api<GitDone<{ commit: Commit }>>('/api/git/commit', { body: { ...at, message, amend } }),
  draft: (at: GitAt) => api<{ message: string }>('/api/git/draft', { body: at }),
  branches: (at: GitAt) => api<Branch[]>(`/api/git/branches?${query(at)}`),
  branch: (at: GitAt, b: { action: 'switch' | 'create' | 'rename' | 'delete'; name: string; to?: string; carry?: 'carry' | 'stash'; force?: boolean }) =>
    api<GitDone>('/api/git/branch', { body: { ...at, ...b } }),
  stash: (at: GitAt, s: { action: 'push' | 'pop' | 'apply' | 'drop'; index?: number; hash?: string; message?: string }) =>
    api<GitDone<{ conflicts: boolean }>>('/api/git/stash', { body: { ...at, ...s } }),
  fetch: (at: GitAt, quiet = false) => api<GitDone>('/api/git/fetch', { body: { ...at, quiet } }),
  pull: (at: GitAt, merge = false) => api<GitDone<{ conflicts: boolean }>>('/api/git/pull', { body: { ...at, merge } }),
  push: (at: GitAt, publish = false) => api<GitDone>('/api/git/push', { body: { ...at, publish } }),
  resolve: (at: GitAt, file: string, force = false) => api<GitDone>('/api/git/resolve', { body: { ...at, file, force } }),
  abort: (at: GitAt) => api<GitDone>('/api/git/abort', { body: at }),
  ask: (at: GitAt, files: string[]) => api<Chat>('/api/git/ask', { body: { ...at, files } }),
  log: (at: GitAt, skip = 0) => api<Commit[]>(`/api/git/log?${query({ ...at, skip: String(skip) })}`),
  commitDetail: (at: GitAt, hash: string) => api<CommitDetail>(`/api/git/commit?${query({ ...at, hash })}`),
  commitDiff: (at: GitAt, hash: string, file: string) => api<GitDiff>(`/api/git/commit?${query({ ...at, hash, file })}`),
}
