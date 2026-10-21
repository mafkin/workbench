import type { AppState, ItemAddr, Op } from '../../shared/config-schema.ts'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Every API call carries X-Workbench; the service refuses calls without it. */
export async function api<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-workbench': '1',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status)
  return data as T
}

export const getState = () => api<AppState>('/api/state')
export const applyOps = (profile: string, rev: string, ops: Op[]) =>
  api<{ rev: string }>(`/api/profiles/${encodeURIComponent(profile)}/ops`, { body: { rev, ops } })
export const undo = (profile: string, rev: string) =>
  api<{ rev: string }>(`/api/profiles/${encodeURIComponent(profile)}/undo`, { body: { rev } })
export const setActive = (profile: string) => api('/api/active', { body: { profile } })
export const openEntry = (profile: string, rev: string, at: ItemAddr) => api('/api/open', { body: { profile, rev, at } })
export const stat = (path: string) =>
  api<{ exists: boolean; kind: 'dir' | 'file' | null }>(`/api/stat?path=${encodeURIComponent(path)}`)
