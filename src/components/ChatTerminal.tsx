// A chat's terminal: xterm.js on the chat's socket. The service keeps the
// program and its screen, so this can come and go with the tab. Loaded on first
// use, as its own chunk, like the note editor.
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { chatToken } from '../lib/api.ts'
import { carriesPaths, droppedPaths, quotePaths, registerTerminal } from '../lib/chats.ts'
import { cx } from '../lib/nav.ts'

// The theme's tame colours for the 16 ANSI colours; claude draws its own UI in true colour.
const ANSI = {
  black: '#1b1d21',
  red: '#c48282',
  green: '#8aa58e',
  yellow: '#c2a36b',
  blue: '#7d93ab',
  magenta: '#a38aa8',
  cyan: '#7fa3a0',
  white: '#d4d6db',
  brightBlack: '#60656e',
  brightRed: '#d49a9a',
  brightGreen: '#a3bba6',
  brightYellow: '#d4b98a',
  brightBlue: '#98abc0',
  brightMagenta: '#b9a3bd',
  brightCyan: '#9bbab7',
  brightWhite: '#eceef1',
}

export default function ChatTerminal({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    const el = host.current!
    const css = getComputedStyle(document.documentElement)
    const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    const term = new Terminal({
      fontFamily: token('--mono', 'monospace'),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: token('--bg', '#141518'),
        foreground: token('--text', '#d4d6db'),
        cursor: token('--accent', '#7d93ab'),
        cursorAccent: token('--bg', '#141518'),
        selectionBackground: 'rgba(125, 147, 171, 0.35)',
        ...ANSI,
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
    term.open(el)
    termRef.current = term
    const doFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
    }
    doFit()

    let ws: WebSocket | null = null
    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 500
    let unregister = () => {}
    const send = (frame: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame)
    }
    // Someone is looking at this chat: the window is focused and visible.
    const sendFocus = () => send(`f${document.hasFocus() && !document.hidden ? 1 : 0}`)

    async function connect() {
      let token: string
      try {
        token = await chatToken()
      } catch {
        return schedule()
      }
      if (disposed) return
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const sock = new WebSocket(`${scheme}://${location.host}/pty/${id}?cols=${term.cols}&rows=${term.rows}`, ['workbench', `wb.${token}`])
      ws = sock
      sock.onopen = () => {
        delay = 500
        sendFocus()
      }
      sock.onmessage = (e) => {
        const frame = String(e.data)
        if (frame[0] === 'r') {
          term.reset()
          term.write(frame.slice(1))
          unregister()
          unregister = registerTerminal(id, (text) => {
            term.paste(text)
            term.focus()
          })
        } else if (frame[0] === 'o') {
          term.write(frame.slice(1))
        }
      }
      sock.onclose = (e) => {
        if (ws === sock) ws = null
        unregister()
        // 4404: the chat was closed. Otherwise the service went away; try again.
        if (!disposed && e.code !== 4404) schedule()
      }
    }
    function schedule() {
      retry = setTimeout(() => void connect(), delay)
      delay = Math.min(delay * 2, 5000)
    }
    void connect()

    const subs = [term.onData((d) => send(`i${d}`)), term.onBinary((d) => send(`i${d}`)), term.onResize(({ cols, rows }) => send(`s${cols},${rows}`))]
    // Copy with Ctrl+Shift+C, as in GNOME Terminal; Ctrl+C stays an interrupt and
    // Ctrl+Shift+V is the browser's paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true
      const key = e.key.toLowerCase()
      if (key === 'c') {
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) void navigator.clipboard?.writeText(selection).catch(() => {})
        return false
      }
      return key !== 'v'
    })
    const ro = new ResizeObserver(doFit)
    ro.observe(el)
    window.addEventListener('focus', sendFocus)
    window.addEventListener('blur', sendFocus)
    document.addEventListener('visibilitychange', sendFocus)
    term.focus()

    return () => {
      disposed = true
      clearTimeout(retry)
      unregister()
      ro.disconnect()
      window.removeEventListener('focus', sendFocus)
      window.removeEventListener('blur', sendFocus)
      document.removeEventListener('visibilitychange', sendFocus)
      for (const s of subs) s.dispose()
      ws?.close()
      term.dispose()
      termRef.current = null
    }
  }, [id])

  return (
    <div
      className={cx('chat-terminal', dropping && 'dropping')}
      ref={host}
      data-chat={id}
      onDragOver={(e) => {
        if (!carriesPaths(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        if (!carriesPaths(e)) return
        e.preventDefault()
        termRef.current?.paste(quotePaths(droppedPaths(e)))
        termRef.current?.focus()
      }}
    />
  )
}
