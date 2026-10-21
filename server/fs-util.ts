// File helpers shared by the config store and notes.
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Content hash used as a file's revision. */
export const revOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** Write through a temp file and rename, so readers never see half a file; `mode` keeps an existing file's permissions. */
export async function writeAtomic(file: string, text: string, mode?: number) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    await fsp.writeFile(tmp, text)
    if (mode !== undefined) await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}
