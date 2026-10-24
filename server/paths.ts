// Where the service may touch the user's files. Paths are resolved through
// symlinks before they are checked against a profile's folders, so `..` or a
// link can never reach anything else.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expandHome, folderRoots, type Profile } from '../shared/config-schema.ts'
import { StoreError } from './config-store.ts'

export interface Root {
  /** As written in the config, made absolute. */
  lexical: string
  /** With symlinks resolved; what paths are checked against. */
  real: string
}

/** `child` is strictly inside `parent`. */
export function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** `child` is `parent` or inside it. */
export const within = (child: string, parent: string) => child === parent || inside(child, parent)

/** An absolute path from `~/…` or `/…`; anything else is refused. */
export function absPath(raw: string, home: string): string {
  const value = raw.trim()
  if (!value) throw new StoreError('path is required', 400)
  const expanded = expandHome(value, home)
  if (!path.isAbsolute(expanded)) throw new StoreError('Path must start with ~ or /', 400)
  return path.resolve(expanded)
}

/** realpath of the longest existing prefix plus the rest; a dangling symlink is refused. */
export async function realish(p: string): Promise<string> {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest.reverse())
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      if ((await fsp.lstat(cur).catch(() => null))?.isSymbolicLink()) throw new StoreError('Not allowed: broken symlink', 403)
      const parent = path.dirname(cur)
      if (parent === cur) return p
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

/**
 * The profile's folders (the Workbench folder when given, the profile's own,
 * folder entries, drawers' folders), resolved; one that cannot be resolved is left out.
 */
export async function browseRoots(profile: Profile, home: string, workbench?: string | null): Promise<Root[]> {
  const out = new Map<string, Root>()
  const all = [...(workbench ? [{ label: 'Workbench', path: workbench }] : []), ...folderRoots(profile)]
  for (const { path: p } of all) {
    try {
      const lexical = absPath(p, home)
      const real = await realish(lexical)
      if (!out.has(real)) out.set(real, { lexical, real })
    } catch {
      // A folder that cannot be resolved allows nothing.
    }
  }
  return [...out.values()]
}
