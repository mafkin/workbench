// Putting trashed files back, by the freedesktop.org Trash spec: `gio trash`
// moves a file into a Trash folder's `files/` and writes `info/<name>.trashinfo`
// with the place it came from (`Path=`, URL-escaped) and when (`DeletionDate=`).
// The home Trash is `$XDG_DATA_HOME/Trash`; other drives keep `.Trash/<uid>` or
// `.Trash-<uid>` at their top folder, where `Path=` is relative to that folder.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface Trashed {
  /** The Trash folder (with `files/` and `info/`). */
  trash: string
  /** The name in `files/`. */
  name: string
}

/** The folder at the top of `p`'s drive: the last one up with the same device. */
async function topOf(p: string): Promise<string> {
  let cur = p
  const dev = (await fsp.stat(cur).catch(() => null))?.dev
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return cur
    const st = await fsp.stat(parent).catch(() => null)
    if (!st || st.dev !== dev) return cur
    cur = parent
  }
}

/** The Trash folders a file at `original` may have gone to. */
export async function trashFolders(original: string, home: string): Promise<{ trash: string; top: string | null }[]> {
  const data = home === os.homedir() && process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : path.join(home, '.local/share')
  const out: { trash: string; top: string | null }[] = [{ trash: path.join(data, 'Trash'), top: null }]
  const uid = process.getuid?.() ?? 0
  const top = await topOf(path.dirname(original))
  if (top !== '/' || !original.startsWith(home)) {
    out.push({ trash: path.join(top, '.Trash', String(uid)), top }, { trash: path.join(top, `.Trash-${uid}`), top })
  }
  return out
}

/** The most recently trashed copy of what was at `original`, if any. */
export async function findTrashed(original: string, home: string): Promise<Trashed | null> {
  let best: (Trashed & { date: string }) | null = null
  for (const { trash, top } of await trashFolders(original, home)) {
    const info = path.join(trash, 'info')
    for (const file of await fsp.readdir(info).catch(() => [] as string[])) {
      if (!file.endsWith('.trashinfo')) continue
      const text = await fsp.readFile(path.join(info, file), 'utf8').catch(() => '')
      const raw = /^Path=(.*)$/m.exec(text)?.[1]
      if (!raw) continue
      let p: string
      try {
        p = decodeURIComponent(raw)
      } catch {
        continue
      }
      if (!path.isAbsolute(p) && top) p = path.join(top, p)
      if (path.resolve(p) !== original) continue
      const date = /^DeletionDate=(.*)$/m.exec(text)?.[1] ?? ''
      if (!best || date > best.date) best = { trash, name: file.slice(0, -'.trashinfo'.length), date }
    }
  }
  return best && { trash: best.trash, name: best.name }
}

/** Move a trashed file back to `original` and drop its info file. */
export async function untrash(t: Trashed, original: string): Promise<void> {
  await fsp.rename(path.join(t.trash, 'files', t.name), original)
  await fsp.rm(path.join(t.trash, 'info', `${t.name}.trashinfo`), { force: true })
}
