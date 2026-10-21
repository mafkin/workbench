import type { AppState } from '../../shared/config-schema.ts'

export type Connection = 'connecting' | 'live' | 'offline'

/**
 * Follow /api/events. Uses fetch rather than EventSource, which cannot send
 * the X-Workbench header. Reconnects with backoff; returns an unsubscribe.
 */
export function followState(onState: (s: AppState) => void, onConnection: (c: Connection) => void): () => void {
  const abort = new AbortController()
  let delay = 500

  async function connect() {
    while (!abort.signal.aborted) {
      try {
        onConnection('connecting')
        const res = await fetch('/api/events', { headers: { 'x-workbench': '1' }, signal: abort.signal })
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`)
        onConnection('live')
        delay = 500
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += value
          let end
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n')
            if (data) onState(JSON.parse(data))
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
