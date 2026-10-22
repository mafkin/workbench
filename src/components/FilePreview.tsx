// The browser's right-hand pane: what the selected file looks like. Media load
// through a short-lived ticket URL, because media elements cannot send the
// X-Workbench header; text and Markdown come from the text endpoint. 3D models
// open in a viewer (a lazy chunk), a .blend shows the preview saved inside it,
// audio its waveform, and two selected images can be compared.
import { ExternalLink, FileText, FolderOpen } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { FileEntry, FileText as FileTextData } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { formatDate, formatSize, previewKind, type PreviewKind } from '../lib/files.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { useThumb } from '../lib/thumbs.ts'
import { AudioPreview } from './AudioPreview.tsx'
import { FileIcon } from './FileIcon.tsx'
import { ImageCompare } from './ImageCompare.tsx'

// react-markdown and remark are a large chunk; they load with the first note shown.
const Markdown = lazy(() => import('./Markdown.tsx').then((m) => ({ default: m.Markdown })))
// three.js loads only when a 3D file is shown.
const ModelPreview = lazy(() => import('./ModelPreview.tsx'))

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Props {
  entry: FileEntry | null
  /** How many entries are selected; the preview shows only for one. */
  count: number
  /** Items in the selected folder, when it has been listed. */
  childCount?: number
  onOpen: (entry: FileEntry) => void
  onOpenDefault: (path: string) => void
  /** Open in the program set up for it (Blender, Godot, the profile's openWith:). */
  onOpenWith?: (path: string) => void
  /** Two images selected: compared. */
  pair?: [FileEntry, FileEntry]
}

export function FilePreview({ entry, count, childCount, onOpen, onOpenDefault, onOpenWith, pair }: Props) {
  if (pair) {
    return (
      <div className="file-preview">
        <header>
          <div className="preview-title">
            <strong>Compare</strong>
            <span>
              {pair[0].name} and {pair[1].name}
            </span>
          </div>
        </header>
        <div className="preview-body">
          <ImageCompare a={pair[0]} b={pair[1]} />
        </div>
      </div>
    )
  }
  if (count > 1) return <div className="preview-empty">{count} items selected</div>
  if (!entry) return <div className="preview-empty">Select a file to preview it</div>
  return <OnePreview entry={entry} childCount={childCount} onOpen={onOpen} onOpenDefault={onOpenDefault} onOpenWith={onOpenWith} />
}

function OnePreview({ entry, childCount, onOpen, onOpenDefault, onOpenWith }: Omit<Props, 'count' | 'pair' | 'entry'> & { entry: FileEntry }) {
  const { profile } = useNotes()
  const kind = previewKind(entry)
  const [program, setProgram] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setProgram(null)
    if (onOpenWith) api.openWithLabel(profile, entry.path).then((r) => live && setProgram(r.label), () => {})
    return () => {
      live = false
    }
  }, [profile, entry.path])
  return (
    <div className="file-preview" key={`${entry.path}:${entry.mtime}`}>
      <header>
        <FileIcon entry={entry} size={18} />
        <div className="preview-title">
          <strong title={entry.path}>{entry.name}</strong>
          <span>
            {entry.kind === 'file' ? formatSize(entry.size) : kind === 'folder' ? 'Folder' : 'Special file'} · {formatDate(entry.mtime)}
            {entry.link && ' · link'}
            {entry.ignored && ' · ignored by .gitignore'}
          </span>
        </div>
        <div className="preview-actions">
          {kind === 'markdown' && (
            <button className="btn primary" onClick={() => onOpen(entry)}>
              <FileText size={14} /> Open as note
            </button>
          )}
          {program && onOpenWith && (
            <button className="btn primary" onClick={() => onOpenWith(entry.path)}>
              <ExternalLink size={14} /> Open in {program}
            </button>
          )}
          {kind === 'folder' ? (
            <button className="btn" onClick={() => onOpen(entry)}>
              <FolderOpen size={14} /> Open
            </button>
          ) : (
            <button className="btn ghost" onClick={() => onOpenDefault(entry.path)} title="Open in default app">
              <ExternalLink size={14} /> Open
            </button>
          )}
        </div>
      </header>
      <div className="preview-body">
        {kind === 'folder' ? (
          <p className="preview-note">
            {childCount === undefined ? 'Double-click or press Enter to open.' : `${childCount} ${childCount === 1 ? 'item' : 'items'}`}
          </p>
        ) : kind === 'markdown' || kind === 'text' ? (
          <TextPreview entry={entry} markdown={kind === 'markdown'} />
        ) : kind === 'model' ? (
          <Suspense fallback={<div className="preview-loading" />}>
            <ModelPreview path={entry.path} name={entry.name} />
          </Suspense>
        ) : kind === 'blend' ? (
          <BlendPreview entry={entry} />
        ) : kind === 'audio' ? (
          <AudioPreview entry={entry} />
        ) : (
          <MediaPreview entry={entry} kind={kind} />
        )}
      </div>
    </div>
  )
}

/** An image, PDF, video or audio file, through a ticket URL. Also used by a project's file tab. */
export function MediaPreview({ entry, kind }: { entry: Pick<FileEntry, 'path' | 'name'>; kind: PreviewKind }) {
  const { profile } = useNotes()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.fileTicket(profile, entry.path).then(
      (r) => live && setUrl(r.url),
      (err) => live && setError(message(err)),
    )
    return () => {
      live = false
    }
  }, [profile, entry.path])

  if (error) return <p className="preview-note">{error}</p>
  if (!url) return <div className="preview-loading" />
  if (kind === 'image') return <ImageView url={url} entry={entry} />
  if (kind === 'pdf') return <iframe className="preview-pdf" src={url} title={entry.name} />
  if (kind === 'video') return <video className="preview-video" src={url} controls preload="metadata" />
  return <audio className="preview-audio" src={url} controls preload="metadata" />
}

/** An image, with its size in pixels and its format under it. */
function ImageView({ url, entry }: { url: string; entry: Pick<FileEntry, 'name'> }) {
  const [dims, setDims] = useState<[number, number] | null>(null)
  const format = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toUpperCase() : ''
  return (
    <>
      <img className="preview-image" src={url} alt={entry.name} onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
      <p className="preview-info" aria-label="Image info">
        {dims ? `${dims[0]} × ${dims[1]} px` : '…'}
        {format && ` · ${format}`}
      </p>
    </>
  )
}

/** A .blend: the preview Blender saved inside it, made by the service. */
function BlendPreview({ entry }: { entry: FileEntry }) {
  const { profile } = useNotes()
  const thumb = useThumb(profile, entry)
  if (thumb.status === 'loading') return <div className="preview-loading" />
  if (thumb.status === 'none') return <p className="preview-note">This .blend was saved without a preview.</p>
  return (
    <>
      <img className="preview-image pixelated" src={thumb.url} alt={entry.name} />
      <p className="preview-info">The preview Blender saved in the file</p>
    </>
  )
}

/** Text, or Markdown formatted, from the first 200 KB. Also used by a project's file tab. */
export function TextPreview({ entry, markdown }: { entry: Pick<FileEntry, 'path' | 'name'>; markdown: boolean }) {
  const { profile } = useNotes()
  const [data, setData] = useState<FileTextData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api.fileText(profile, entry.path).then(
      (t) => live && setData(t),
      (err) => live && setError(message(err)),
    )
    return () => {
      live = false
    }
  }, [profile, entry.path])

  if (error) return <p className="preview-note">{error}</p>
  if (!data) return <div className="preview-loading" />
  if (data.binary) return <p className="preview-note">No preview for this kind of file.</p>
  if (!data.text) return <p className="preview-note">Empty file</p>
  return (
    <>
      {markdown ? (
        <Suspense fallback={null}>
          <Markdown text={data.text} notePath={entry.path} />
        </Suspense>
      ) : (
        <pre className="preview-text">{data.text}</pre>
      )}
      {data.truncated && <p className="preview-note">Showing the first 200 KB of {formatSize(data.size)}.</p>}
    </>
  )
}
