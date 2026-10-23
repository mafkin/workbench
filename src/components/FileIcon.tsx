import { Box, File, FileAudio, FileImage, FileText, FileVideo, Folder, FolderOpen } from 'lucide-react'
import type { FileEntry } from '../../shared/config-schema.ts'
import { previewKind } from '../lib/files.ts'

const ICONS = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  model: Box,
  blend: Box,
  pdf: FileText,
  markdown: FileText,
  text: File,
}

export function FileIcon({ entry, open = false, size = 15 }: { entry: Pick<FileEntry, 'name' | 'kind'>; open?: boolean; size?: number }) {
  const kind = previewKind(entry)
  if (kind === 'folder') {
    const Icon = open ? FolderOpen : Folder
    return <Icon size={size} className="icon folder" />
  }
  const Icon = ICONS[kind]
  return <Icon size={size} className="icon" />
}
