// Helpers for the file browser: paths in `~/…` form, names, formatting, and what a file previews as.
import type { FileEntry } from '../../shared/config-schema.ts'

export type PreviewKind = 'folder' | 'image' | 'pdf' | 'video' | 'audio' | 'markdown' | 'text'

const EXT_KIND: Record<string, PreviewKind> = {}
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp']) EXT_KIND[e] = 'image'
for (const e of ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']) EXT_KIND[e] = 'video'
for (const e of ['mp3', 'ogg', 'oga', 'opus', 'flac', 'wav', 'm4a', 'aac']) EXT_KIND[e] = 'audio'
EXT_KIND.pdf = 'pdf'
EXT_KIND.md = 'markdown'
EXT_KIND.markdown = 'markdown'

const extOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')

/** Anything not known as media is tried as text; the service says when it is binary. */
export function previewKind(entry: Pick<FileEntry, 'name' | 'kind'>): PreviewKind {
  if (entry.kind === 'dir') return 'folder'
  return EXT_KIND[extOf(entry.name)] ?? 'text'
}

export const isMarkdown = (name: string) => EXT_KIND[extOf(name)] === 'markdown'

/** `~/a/b` -> `~/a`, `/a` -> `/`. */
export function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  return p.slice(0, i)
}

export const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p

/** Each step of a path for the path bar: `~/a/b` -> `~`, `~/a`, `~/a/b`. */
export function segments(p: string): { name: string; path: string }[] {
  const parts = p.split('/')
  const out: { name: string; path: string }[] = []
  if (p.startsWith('/')) out.push({ name: '/', path: '/' })
  let acc = p.startsWith('/') ? '' : undefined
  for (const part of parts) {
    if (!part) continue
    acc = acc === undefined ? part : `${acc}/${part}`
    out.push({ name: part, path: acc })
  }
  return out
}

/** `New folder`, then `New folder 2`, …; for files the number goes before the extension. */
export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`
}

/** Today: the time; this year: day and month; otherwise with the year. */
export function formatDate(ms: number, now = new Date()): string {
  const d = new Date(ms)
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
