// The browser's right-hand pane: what the selected file looks like. Media load
// through a short-lived ticket URL, because media elements cannot send the
// X-Workbench header; text and Markdown come from the text endpoint.
import { ExternalLink, FileText, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileEntry, FileText as FileTextData } from '../../shared/config-schema.ts'
import * as api from '../lib/api.ts'
import { formatDate, formatSize, previewKind, type PreviewKind } from '../lib/files.ts'
import { useNotes } from '../lib/notes-ctx.ts'
import { FileIcon } from './FileIcon.tsx'
import { Markdown } from './Markdown.tsx'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Props {
  entry: FileEntry | null
  /** How many entries are selected; the preview shows only for one. */
  count: number
  /** Items in the selected folder, when it has been listed. */
  childCount?: number
  onOpen: (entry: FileEntry) => void
  onOpenDefault: (path: string) => void
}

export function FilePreview({ entry, count, childCount, onOpen, onOpenDefault }: Props) {
  if (count > 1) return <div className="preview-empty">{count} items selected</div>
  if (!entry) return <div className="preview-empty">Select a file to preview it</div>
  const kind = previewKind(entry)
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
        ) : (
          <MediaPreview entry={entry} kind={kind} />
        )}
      </div>
    </div>
  )
}

function MediaPreview({ entry, kind }: { entry: FileEntry; kind: PreviewKind }) {
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
  if (kind === 'image') return <img className="preview-image" src={url} alt={entry.name} />
  if (kind === 'pdf') return <iframe className="preview-pdf" src={url} title={entry.name} />
  if (kind === 'video') return <video className="preview-video" src={url} controls preload="metadata" />
  return <audio className="preview-audio" src={url} controls preload="metadata" />
}

function TextPreview({ entry, markdown }: { entry: FileEntry; markdown: boolean }) {
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
      {markdown ? <Markdown text={data.text} notePath={entry.path} /> : <pre className="preview-text">{data.text}</pre>}
      {data.truncated && <p className="preview-note">Showing the first 200 KB of {formatSize(data.size)}.</p>}
    </>
  )
}
