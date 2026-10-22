import type {
  AppState,
  Chat,
  ClaudeSession,
  FileListing,
  FileOp,
  FileOpResult,
  FileText,
  ItemAddr,
  NoteFile,
  NoteSummary,
  Op,
  SearchHit,
} from '../../shared/config-schema.ts'

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
  api<{ path: string; rev: string; mtime: number }>('/api/notes/file', {
    body: { profile, path, rev, text },
    keepalive: keepalive && text.length < 60_000,
  })
export const listNotes = (profile: string) => api<NoteSummary[]>(`/api/notes/list?${query({ profile })}`)
export const searchNotes = (profile: string, q: string) => api<SearchHit[]>(`/api/notes/search?${query({ profile, q })}`)

export const listFiles = (profile: string, path: string) => api<FileListing>(`/api/files/list?${query({ profile, path })}`)
export const fileText = (profile: string, path: string) => api<FileText>(`/api/files/text?${query({ profile, path })}`)
/** A short-lived URL for media elements, which cannot send the X-Workbench header. */
/** With `folder`, an HTML report's URL also serves the files next to it. */
export const fileTicket = (profile: string, path: string, folder = false) =>
  api<{ url: string }>('/api/files/ticket', { body: { profile, path, folder } })
export const fileOp = <T extends FileOpResult = FileOpResult>(profile: string, op: FileOp) =>
  api<T>('/api/files/op', { body: { profile, op } })
export const openFile = (profile: string, path: string) => api('/api/files/open', { body: { profile, path } })

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

/** Images in notes go through fetch, because an <img> cannot send the X-Workbench header. */
export async function noteImage(profile: string, path: string): Promise<Blob> {
  const res = await fetch(`/api/notes/asset?${query({ profile, path })}`, { headers: { 'x-workbench': '1' } })
  if (!res.ok) throw new ApiError(res.statusText, res.status)
  return res.blob()
}
