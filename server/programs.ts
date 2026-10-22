// Finding programs to run: claude and the shell for chats, Blender and Godot
// for "Open with".
import fs from 'node:fs'
import path from 'node:path'

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A program by name on PATH, then in the places claude's installers use. */
export function findProgram(name: string, home: string, envPath = process.env.PATH ?? ''): string | null {
  if (name.includes('/')) return executable(name) ? name : null
  const dirs = [...envPath.split(':').filter(Boolean), path.join(home, '.local/bin'), path.join(home, '.claude/local'), '/usr/local/bin', '/usr/bin']
  for (const dir of dirs) {
    const file = path.join(dir, name)
    if (executable(file)) return file
  }
  return null
}
