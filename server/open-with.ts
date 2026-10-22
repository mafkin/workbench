// "Open with": the program a file opens in. The profile's `openWith:` rules
// come first, then the built-in ones, which apply only when the program is
// installed: .blend files in Blender, a Godot project's files (and the project
// folder) in the Godot editor. A request names only the file; the command and
// its arguments come from here, each placeholder becoming one argument.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expandHome, type OpenRule, type Profile } from '../shared/config-schema.ts'
import { findProgram } from './programs.ts'

export interface OpenProgram {
  /** For the menu: "Open in <label>". */
  label: string
  command: string
  args: string[]
  cwd: string
}

const DEFAULTS: OpenRule[] = [
  { ext: ['blend'], command: 'blender', args: ['{file}'], label: 'Blender' },
  { ext: ['godot', 'tscn', 'scn', 'gd', 'gdshader', 'tres', 'res'], command: 'godot', args: ['--editor', '--path', '{godot}'], label: 'Godot' },
]

/** The nearest folder from `dir` up that holds a project.godot. */
export async function godotProject(dir: string): Promise<string | null> {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if ((await fsp.stat(path.join(cur, 'project.godot')).catch(() => null))?.isFile()) return cur
    if (path.dirname(cur) === cur) return null
  }
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The program `real` (a resolved, confined path) opens in, or null for the
 * default app. A folder holding a project.godot counts as a Godot project.
 */
export async function openProgram(profile: Profile, real: string, home: string, find = findProgram): Promise<OpenProgram | null> {
  const isDir = (await fsp.stat(real).catch(() => null))?.isDirectory() ?? false
  let ext = path.extname(real).slice(1).toLowerCase()
  if (/^blend\d+$/.test(ext)) ext = 'blend'
  if (isDir) {
    if (!(await fsp.stat(path.join(real, 'project.godot')).catch(() => null))) return null
    ext = 'godot'
  }
  const dir = isDir ? real : path.dirname(real)
  const user = profile.openWith ?? []
  for (const [i, rule] of [...user, ...DEFAULTS].entries()) {
    if (!rule.ext.includes(ext)) continue
    const wanted = expandHome(rule.command, home)
    const found = find(wanted, home)
    // A built-in rule needs its program installed; one of yours runs as written (and says if it isn't there).
    if (!found && i >= user.length) continue
    const godot = (await godotProject(dir)) ?? dir
    const file = isDir ? path.join(real, 'project.godot') : real
    const args = rule.args.map((a) => a.replaceAll('{file}', file).replaceAll('{dir}', dir).replaceAll('{godot}', godot))
    return { label: rule.label ?? titleCase(path.basename(rule.command)), command: found ?? wanted, args, cwd: ext === 'godot' || rule.args.some((a) => a.includes('{godot}')) ? godot : dir }
  }
  return null
}
