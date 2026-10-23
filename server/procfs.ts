// Which of your processes listen on a TCP port, read from /proc: the listening
// sockets in /proc/net/tcp{,6}, matched to processes by the socket inodes in
// their /proc/<pid>/fd, with each process's folder, name, command and start.
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface Listener {
  port: number
  address: string
  inode: number
  uid: number
}

export interface ProcessInfo {
  pid: number
  /** Its working folder (resolved). */
  cwd: string
  name: string
  command: string[]
  /** When it started, ms since the epoch. */
  started: number
}

const LISTEN = '0A'

/** `0100007F` (little-endian bytes) → `127.0.0.1`; 32 hex digits → a compressed IPv6 address. */
function address(hex: string, family: 4 | 6): string {
  const bytes = (h: string) => h.match(/../g)!.map((b) => parseInt(b, 16))
  if (family === 4) return bytes(hex).reverse().join('.')
  // Four 32-bit words, each little-endian.
  const all = (hex.match(/.{8}/g) ?? []).flatMap((w) => bytes(w).reverse())
  const groups = Array.from({ length: 8 }, (_, i) => ((all[i * 2] << 8) | all[i * 2 + 1]).toString(16))
  // The longest run of zero groups (two or more) becomes "::".
  let best = { at: -1, len: 0 }
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best.len && j - i > 1) best = { at: i, len: j - i }
    i = j
  }
  if (best.at < 0) return groups.join(':')
  return `${groups.slice(0, best.at).join(':')}::${groups.slice(best.at + best.len).join(':')}`
}

/** Listening sockets in a /proc/net/tcp or tcp6 file. */
export function parseNetTcp(text: string, family: 4 | 6): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== LISTEN) continue
    const [addr, port] = f[1].split(':')
    out.push({ port: parseInt(port, 16), address: address(addr, family), inode: Number(f[9]), uid: Number(f[7]) })
  }
  return out
}

let ticks: number | null = null
/** Clock ticks per second, for process start times (/proc/<pid>/stat field 22). */
function clockTicks(): number {
  if (ticks === null) {
    try {
      ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100
    } catch {
      ticks = 100
    }
  }
  return ticks
}

export class Procfs {
  readonly root: string

  constructor(root = '/proc') {
    this.root = root
  }

  async listeners(): Promise<Listener[]> {
    const read = (f: string) => fsp.readFile(path.join(this.root, 'net', f), 'utf8').catch(() => '')
    return [...parseNetTcp(await read('tcp'), 4), ...parseNetTcp(await read('tcp6'), 6)]
  }

  /** The processes (yours only) holding these socket inodes, by inode. */
  async owners(inodes: Set<number>, uid: number): Promise<Map<number, number>> {
    const out = new Map<number, number>()
    if (!inodes.size) return out
    for (const name of await fsp.readdir(this.root).catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue
      const dir = path.join(this.root, name)
      if ((await fsp.stat(dir).catch(() => null))?.uid !== uid) continue
      for (const fd of await fsp.readdir(path.join(dir, 'fd')).catch(() => [] as string[])) {
        const link = await fsp.readlink(path.join(dir, 'fd', fd)).catch(() => '')
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m && inodes.has(Number(m[1])) && !out.has(Number(m[1]))) out.set(Number(m[1]), Number(name))
      }
    }
    return out
  }

  async process(pid: number): Promise<ProcessInfo | null> {
    const dir = path.join(this.root, String(pid))
    const [cwd, comm, cmdline, stat, sys] = await Promise.all([
      fsp.readlink(path.join(dir, 'cwd')).catch(() => null),
      fsp.readFile(path.join(dir, 'comm'), 'utf8').catch(() => ''),
      fsp.readFile(path.join(dir, 'cmdline'), 'utf8').catch(() => ''),
      fsp.readFile(path.join(dir, 'stat'), 'utf8').catch(() => ''),
      fsp.readFile(path.join(this.root, 'stat'), 'utf8').catch(() => ''),
    ])
    if (!cwd) return null
    // The name in stat may hold spaces and parentheses; the fields after the last ")" are plain.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[19])
    const boot = Number(/^btime (\d+)/m.exec(sys)?.[1] ?? 0)
    const command = cmdline.split('\0').filter(Boolean)
    // comm is the main thread's name ("node-MainThread" on Node 26.11), so the
    // program comes first; comm only when the process rewrote its command line.
    const program = command[0] && !/\s/.test(command[0]) ? path.basename(command[0]) : ''
    return {
      pid,
      cwd: cwd.replace(/ \(deleted\)$/, ''),
      name: program || comm.trim(),
      command,
      started: boot && startTicks ? (boot + startTicks / clockTicks()) * 1000 : 0,
    }
  }
}
