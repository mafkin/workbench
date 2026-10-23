// Drawer logos: a picture is cover-cropped to 64×64 here and sent as PNG, so a
// logo never outgrows the narrowest sidebar; shown through blob URLs because
// an <img> cannot send the X-Workbench header.
import { useEffect, useState } from 'react'
import { ApiError } from './api.ts'

export const LOGO_PX = 64

/** A 64×64 PNG of the middle of a picture. */
export async function makeLogo(picture: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(picture).catch(() => {
    throw new Error('Cannot read this picture')
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = LOGO_PX
  const g = canvas.getContext('2d')
  if (!g) throw new Error('Cannot draw the logo')
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, LOGO_PX, LOGO_PX)
  bitmap.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Cannot make the logo'))), 'image/png'))
}

/** Keep a logo in the service; returns the name for the drawer's `logo:`. */
export async function putLogo(png: Blob): Promise<string> {
  const res = await fetch('/api/logos', { method: 'PUT', headers: { 'x-workbench': '1', 'content-type': 'image/png' }, body: png })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, res.status)
  return data.name
}

// Logos are named by their content, so a blob URL never goes stale.
const urls = new Map<string, Promise<string | null>>()

function logoUrl(name: string): Promise<string | null> {
  let url = urls.get(name)
  if (!url) {
    url = fetch(`/api/logos/${encodeURIComponent(name)}`, { headers: { 'x-workbench': '1' } }).then(
      async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null),
      () => null,
    )
    urls.set(name, url)
  }
  return url
}

/** A logo's blob URL; null while loading, without a name, or when it is gone. */
export function useLogo(name: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!name) return
    let live = true
    void logoUrl(name).then((u) => live && setUrl(u))
    return () => {
      live = false
    }
  }, [name])
  return url
}
