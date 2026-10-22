// Opening entries outside the app: links and paths through xdg-open, launchers
// as their own detached process. Arguments go straight to the program; no shell.
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import { expandHome, type NavItem } from '../shared/config-schema.ts'

export class LaunchError extends Error {}

export interface Launch {
  command: string
  args: string[]
  cwd?: string
}

type SpawnFn = typeof nodeSpawn

export function launchFor(item: NavItem, home: string): Launch {
  switch (item.type) {
    case 'link':
      return { command: 'xdg-open', args: [item.url] }
    case 'folder':
    case 'note':
      return { command: 'xdg-open', args: [expandHome(item.path, home)] }
    case 'launch':
      return {
        command: expandHome(item.command, home),
        args: item.args.map((a) => expandHome(a, home)),
        cwd: item.cwd ? expandHome(item.cwd, home) : undefined,
      }
    default:
      throw new LaunchError(`A ${item.type} entry cannot be opened outside the app`)
  }
}

/** Start the program and resolve once it is running; it outlives the service. */
export function runDetached(launch: Launch, spawn: SpawnFn = nodeSpawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(new LaunchError(err.code === 'ENOENT' ? `Command not found: ${launch.command}` : err.message))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Run a command to its end, e.g. `gio trash`; fails with what it printed to stderr. */
export function runToExit(launch: Launch, spawn: SpawnFn = nodeSpawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, stdio: ['ignore', 'ignore', 'pipe'], shell: false })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(new LaunchError(err.code === 'ENOENT' ? `Command not found: ${launch.command}` : err.message))
    })
    child.once('close', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new LaunchError(stderr.trim() || `${launch.command} failed (exit ${code})`))
    })
  })
}

export async function openItem(item: NavItem, home: string, spawn: SpawnFn = nodeSpawn): Promise<void> {
  const launch = launchFor(item, home)
  // Check paths first: xdg-open runs detached, so its own errors would be lost,
  // and spawn reports a missing cwd as a missing command.
  if (item.type === 'folder' || item.type === 'note') {
    if (!fs.existsSync(launch.args[0])) throw new LaunchError(`Not found: ${item.path}`)
  }
  if (launch.cwd && !fs.statSync(launch.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new LaunchError(`Folder not found: ${item.type === 'launch' ? item.cwd : launch.cwd}`)
  }
  await runDetached(launch, spawn)
}
