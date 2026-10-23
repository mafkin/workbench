// Gallery thumbnails. Each tile asks the service for its cached thumbnail; when
// there is none, the browser makes one (images, video frames, audio waveforms,
// 3D renders) from the original through a ticket, uploads it to the cache, and
// shows it. A few at a time, in order; a tile scrolled away before its turn is skipped.
import { useEffect, useState } from 'react'
import type { FileEntry } from '../../shared/config-schema.ts'
import { ApiError, fileTicket } from './api.ts'

export type Thumb = { status: 'loading' } | { status: 'ok'; url: string } | { status: 'none' }

type Make = 'image' | 'video' | 'audio' | 'model'

/** The longest side of a thumbnail, in pixels. */
export const THUMB_PX = 256
const MAX_AUDIO = 50 * 1024 * 1024
const KEEP = 600

const known = new Map<string, Thumb>()
const waiting = new Map<string, Set<(t: Thumb) => void>>()
const queue: (() => Promise<void>)[] = []
let running = 0

const keyOf = (profile: string, e: Pick<FileEntry, 'path' | 'mtime' | 'size'>) => `${profile}|${e.path}|${e.mtime}|${e.size}`

function settle(key: string, t: Thumb) {
  known.set(key, t)
  // Keep the most recent; let the browser free the rest.
  if (known.size > KEEP) {
    for (const [k, old] of known) {
      if (known.size <= KEEP) break
      if (old.status === 'ok' && !waiting.has(k)) URL.revokeObjectURL(old.url)
      known.delete(k)
    }
  }
  for (const fn of waiting.get(key) ?? []) fn(t)
  waiting.delete(key)
}

function pump() {
  while (running < 4 && queue.length) {
    const job = queue.shift()!
    running++
    void job().finally(() => {
      running--
      pump()
    })
  }
}

/** The thumbnail of a file (or a Godot project folder), made if need be. */
export function useThumb(profile: string, entry: Pick<FileEntry, 'path' | 'mtime' | 'size' | 'name' | 'kind'>, enabled = true): Thumb {
  const key = keyOf(profile, entry)
  const [thumb, setThumb] = useState<Thumb>(() => known.get(key) ?? { status: 'loading' })
  useEffect(() => {
    const hit = known.get(key)
    if (hit) return setThumb(hit)
    setThumb({ status: 'loading' })
    if (!enabled) return
    let on = true
    const listen = (t: Thumb) => on && setThumb(t)
    if (waiting.has(key)) waiting.get(key)!.add(listen)
    else {
      waiting.set(key, new Set([listen]))
      queue.push(() => load(profile, entry, key))
      pump()
    }
    return () => {
      on = false
      waiting.get(key)?.delete(listen)
    }
  }, [key, enabled])
  return thumb
}

async function load(profile: string, entry: Pick<FileEntry, 'path' | 'size' | 'name'>, key: string): Promise<void> {
  // Nobody is looking any more (scrolled past): leave it for next time.
  if (!waiting.get(key)?.size) {
    waiting.delete(key)
    return
  }
  const q = new URLSearchParams({ profile, path: entry.path })
  try {
    const res = await fetch(`/api/thumbs?${q}`, { headers: { 'x-workbench': '1' } })
    if (res.ok) return settle(key, { status: 'ok', url: URL.createObjectURL(await res.blob()) })
    const hint = (await res.json().catch(() => ({}))) as { make?: Make | null; source?: string }
    if (res.status !== 404 || !hint.make) return settle(key, { status: 'none' })
    if (hint.make === 'audio' && entry.size > MAX_AUDIO) return settle(key, { status: 'none' })
    const blob = await make(profile, hint.make, hint.source ?? entry.path)
    if (!blob) return settle(key, { status: 'none' })
    settle(key, { status: 'ok', url: URL.createObjectURL(blob) })
    await fetch(`/api/thumbs?${q}`, { method: 'PUT', headers: { 'x-workbench': '1', 'content-type': blob.type }, body: blob }).catch(() => {})
  } catch (err) {
    if (!(err instanceof ApiError)) console.warn('[thumbs]', entry.path, err)
    settle(key, { status: 'none' })
  }
}

/** Make a thumbnail in the browser from the original. */
export async function make(profile: string, kind: Make, path: string): Promise<Blob | null> {
  const { url } = await fileTicket(profile, path, kind === 'model')
  if (kind === 'image') return toBlob(fit(await loadImage(url)))
  if (kind === 'video') return toBlob(fit(await videoFrame(url)))
  if (kind === 'audio') return toBlob(await waveform(url))
  const { renderThumb } = await import('../components/ModelPreview.tsx')
  return toBlob(await renderThumb(url, path))
}

type Drawable = { source: CanvasImageSource; width: number; height: number }

function loadImage(url: string): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ source: img, width: img.naturalWidth || THUMB_PX, height: img.naturalHeight || THUMB_PX })
    img.onerror = () => reject(new Error('Cannot decode this image'))
    img.src = url
  })
}

/** A frame a tenth of the way in (at most 5 s), so it isn't the black first frame. */
function videoFrame(url: string): Promise<Drawable> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    const timer = setTimeout(() => reject(new Error('The video took too long')), 10_000)
    v.muted = true
    v.preload = 'auto'
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(5, (v.duration || 0) * 0.1)
    }
    v.onseeked = () => {
      clearTimeout(timer)
      resolve({ source: v, width: v.videoWidth, height: v.videoHeight })
    }
    v.onerror = () => {
      clearTimeout(timer)
      reject(new Error('Cannot play this video'))
    }
    v.src = url
  })
}

/** Scale into a THUMB_PX box, keeping the shape. */
function fit(d: Drawable): HTMLCanvasElement {
  const scale = Math.min(1, THUMB_PX / Math.max(d.width, d.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(d.width * scale))
  c.height = Math.max(1, Math.round(d.height * scale))
  c.getContext('2d')!.drawImage(d.source, 0, 0, c.width, c.height)
  return c
}

/** The loudest sample in each of `n` slices, per channel mixed, 0..1. */
export function peaks(buffer: AudioBuffer, n: number): number[] {
  const out = new Array<number>(n).fill(0)
  const per = Math.max(1, Math.floor(buffer.length / n))
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < n; i++) {
      let max = 0
      const end = Math.min(data.length, (i + 1) * per)
      for (let j = i * per; j < end; j++) max = Math.max(max, Math.abs(data[j]))
      out[i] = Math.max(out[i], max)
    }
  }
  return out
}

export async function decodeAudio(url: string): Promise<AudioBuffer> {
  const bytes = await (await fetch(url)).arrayBuffer()
  return new OfflineAudioContext(1, 1, 44_100).decodeAudioData(bytes)
}

/** Draw a waveform: bars mirrored around the middle line. */
export function drawWave(c: HTMLCanvasElement, p: number[], color: string, played = 0, playedColor = color) {
  const g = c.getContext('2d')!
  g.clearRect(0, 0, c.width, c.height)
  const bar = c.width / p.length
  const mid = c.height / 2
  for (let i = 0; i < p.length; i++) {
    const h = Math.max(1, p[i] * (c.height - 4))
    g.fillStyle = i / p.length < played ? playedColor : color
    g.fillRect(i * bar, mid - h / 2, Math.max(1, bar - 1), h)
  }
}

async function waveform(url: string): Promise<HTMLCanvasElement> {
  const buffer = await decodeAudio(url)
  const c = document.createElement('canvas')
  c.width = THUMB_PX
  c.height = Math.round(THUMB_PX * 0.6)
  drawWave(c, peaks(buffer, 96), '#9aa3ad')
  return c
}

function toBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) =>
    c.toBlob(
      (b) => {
        // A browser that cannot write WebP gives PNG instead, which the cache takes too.
        resolve(b && (b.type === 'image/webp' || b.type === 'image/png') ? b : null)
      },
      'image/webp',
      0.85,
    ),
  )
}
