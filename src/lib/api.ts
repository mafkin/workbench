import type {
  AppState,
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
export const openEntry = (profile: string, rev: string, at: ItemAddr) => api('/api/open', { body: { profile, rev, at } })
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
export const fileTicket = (profile: string, path: string) => api<{ url: string }>('/api/files/ticket', { body: { profile, path } })
export const fileOp = <T extends FileOpResult = FileOpResult>(profile: string, op: FileOp) =>
  api<T>('/api/files/op', { body: { profile, op } })
export const openFile = (profile: string, path: string) => api('/api/files/open', { body: { profile, path } })

/** Images in notes go through fetch, because an <img> cannot send the X-Workbench header. */
export async function noteImage(profile: string, path: string): Promise<Blob> {
  const res = await fetch(`/api/notes/asset?${query({ profile, path })}`, { headers: { 'x-workbench': '1' } })
  if (!res.ok) throw new ApiError(res.statusText, res.status)
  return res.blob()
}
