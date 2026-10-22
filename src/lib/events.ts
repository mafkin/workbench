import type { AppState } from '../../shared/config-schema.ts'

export type Connection = 'connecting' | 'live' | 'offline'

export interface NoteEvent {
  path: string
  rev: string | null
}

export interface FilesEvent {
  /** A listed folder whose contents changed. */
  path: string
}

export interface ChatsEvent {
  /** The profile whose chats changed. */
  profile: string
}

// Open notes and file browsers listen here: to changes on disk, and to
// reconnects (the service may have restarted and stopped watching). The chat
// list listens for chats starting, stopping or wanting attention.
const noteListeners = new Set<(e: NoteEvent | 'reconnected') => void>()
const filesListeners = new Set<(e: FilesEvent | 'reconnected') => void>()
const chatsListeners = new Set<(e: ChatsEvent | 'reconnected') => void>()
const contextListeners = new Set<(e: ChatsEvent | 'reconnected') => void>()

export function onNoteEvent(fn: (e: NoteEvent | 'reconnected') => void): () => void {
  noteListeners.add(fn)
  return () => {
    noteListeners.delete(fn)
  }
}

export function onFilesEvent(fn: (e: FilesEvent | 'reconnected') => void): () => void {
  filesListeners.add(fn)
  return () => {
    filesListeners.delete(fn)
  }
}

/** A profile's context folders changed (set up, inbox count). Same shape as a chats event. */
export function onContextEvent(fn: (e: ChatsEvent | 'reconnected') => void): () => void {
  contextListeners.add(fn)
  return () => {
    contextListeners.delete(fn)
  }
}

export function onChatsEvent(fn: (e: ChatsEvent | 'reconnected') => void): () => void {
  chatsListeners.add(fn)
  return () => {
    chatsListeners.delete(fn)
  }
}

/**
 * Follow /api/events. Uses fetch rather than EventSource, which cannot send
 * the X-Workbench header. Reconnects with backoff; returns an unsubscribe.
 */
export function followState(onState: (s: AppState) => void, onConnection: (c: Connection) => void): () => void {
  const abort = new AbortController()
  let delay = 500
  let connectedBefore = false

  async function connect() {
    while (!abort.signal.aborted) {
      try {
        onConnection('connecting')
        const res = await fetch('/api/events', { headers: { 'x-workbench': '1' }, signal: abort.signal })
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`)
        onConnection('live')
        if (connectedBefore) {
          for (const fn of noteListeners) fn('reconnected')
          for (const fn of filesListeners) fn('reconnected')
          for (const fn of chatsListeners) fn('reconnected')
          for (const fn of contextListeners) fn('reconnected')
        }
        connectedBefore = true
        delay = 500
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const lines = buffer.slice(0, end).split('\n')
            buffer = buffer.slice(end + 2)
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message'
            const data = lines
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (!data) continue
            if (event === 'note') {
              const e = JSON.parse(data) as NoteEvent
              for (const fn of noteListeners) fn(e)
            } else if (event === 'files') {
              const e = JSON.parse(data) as FilesEvent
              for (const fn of filesListeners) fn(e)
            } else if (event === 'chats') {
              const e = JSON.parse(data) as ChatsEvent
              for (const fn of chatsListeners) fn(e)
            } else if (event === 'context') {
              const e = JSON.parse(data) as ChatsEvent
              for (const fn of contextListeners) fn(e)
            } else {
              onState(JSON.parse(data))
            }
          }
        }
      } catch {
        if (abort.signal.aborted) return
      }
      onConnection('offline')
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 5000)
    }
  }

  void connect()
  return () => abort.abort()
}
