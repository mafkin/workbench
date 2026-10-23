// File helpers shared by the config store, notes and thumbnails.
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Content hash used as a file's revision. */
export const revOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** Write through a temp file and rename, so readers never see half a file; `mode` keeps an existing file's permissions. */
export async function writeAtomic(file: string, text: string | Uint8Array, mode?: number) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    // Made with the mode, so a private file is never readable by others, not even briefly.
    await fsp.writeFile(tmp, text, mode !== undefined ? { mode } : undefined)
    if (mode !== undefined) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}
