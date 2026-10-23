// An audio file in the preview pane: its waveform (decoded in the browser, up
// to 50 MB) with play/pause, click to seek, and its length and channels. (The
// browser decodes at its own rate, so the file's sample rate isn't shown.)
import { Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FileEntry } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { decodeAudio, drawWave, peaks } from '../lib/thumbs.ts'

const MAX_DECODE = 50 * 1024 * 1024

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function AudioPreview({ entry }: { entry: Pick<FileEntry, 'path' | 'name' | 'size'> }) {
  const { profile } = useNotes()
  const [url, setUrl] = useState<string | null>(null)
  const [wave, setWave] = useState<{ peaks: number[]; duration: number; channels: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const audio = useRef<HTMLAudioElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let live = true
    api.fileTicket(profile, entry.path).then(
      async (r) => {
        if (!live) return
        setUrl(r.url)
        if (entry.size > MAX_DECODE) return
        const buffer = await decodeAudio(r.url)
        if (live) setWave({ peaks: peaks(buffer, 300), duration: buffer.duration, channels: buffer.numberOfChannels })
      },
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [profile, entry.path, entry.size])

  // Drawn in the theme's colours; the part already played in the accent.
  useEffect(() => {
    const c = canvas.current
    if (!c || !wave) return
    const css = getComputedStyle(document.documentElement)
    c.width = c.clientWidth * devicePixelRatio
    c.height = c.clientHeight * devicePixelRatio
    drawWave(c, wave.peaks, css.getPropertyValue('--faint').trim() || '#60656e', wave.duration ? at / wave.duration : 0, css.getPropertyValue('--accent').trim() || '#7d93ab')
  }, [wave, at])

  if (error) return <p className="preview-note">{error}</p>
  if (!url) return <div className="preview-loading" />
  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }
  return (
    <div className="audio-preview">
      <audio ref={audio} src={url} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} />
      {wave ? (
        <canvas
          ref={canvas}
          className="audio-wave"
          aria-label="Waveform"
          onClick={(e) => {
            const a = audio.current
            const r = e.currentTarget.getBoundingClientRect()
            if (a && wave.duration) a.currentTime = ((e.clientX - r.left) / r.width) * wave.duration
          }}
        />
      ) : (
        <p className="preview-note">{entry.size > MAX_DECODE ? 'Too long to draw its waveform; it still plays.' : 'Reading…'}</p>
      )}
      <div className="audio-bar">
        <button className="btn ghost small" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <span className="mono">
          {clock(at)}
          {wave && ` / ${clock(wave.duration)}`}
        </span>
        {wave && (
          <span className="hint">{wave.channels === 1 ? 'mono' : wave.channels === 2 ? 'stereo' : `${wave.channels} channels`}</span>
        )}
      </div>
    </div>
  )
}
