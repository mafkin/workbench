// Watching folders for changes. Folders rather than files: editors and atomic
// saves replace a file, which ends a watch on the file itself.
import fs from 'node:fs'
import path from 'node:path'

export interface WatchHandlers {
  /** Something named `name` in `dir` was created, written, renamed or deleted. */
  change: (dir: string, name: string) => void
  /** The folder itself was deleted or moved; called a moment later, once it is watched again if it came back. */
  replaced?: (dir: string) => void
  /** The folder is no longer watched: too many folders, or an error. */
  dropped?: (dir: string) => void
}

/** Watches up to `max` folders, dropping the least recently used. */
export class FolderWatcher {
  #max: number
  #on: WatchHandlers
  /** Oldest first. */
  #watchers = new Map<string, fs.FSWatcher>()
  #timers = new Map<string, NodeJS.Timeout>()

  constructor(max: number, on: WatchHandlers) {
    this.#max = max
    this.#on = on
  }

  /** Watch `dir`, or mark it recently used. False when it does not exist. */
  watch(dir: string): boolean {
    const existing = this.#watchers.get(dir)
    if (existing) {
      this.#watchers.delete(dir)
      this.#watchers.set(dir, existing)
      return true
    }
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (!name) return
        if (name === path.basename(dir)) this.#replaced(dir)
        else this.#on.change(dir, name)
      })
    } catch {
      return false
    }
    watcher.on('error', () => this.#drop(dir))
    this.#watchers.set(dir, watcher)
    if (this.#watchers.size > this.#max) this.#drop(this.#watchers.keys().next().value!)
    return true
  }

  close() {
    for (const w of this.#watchers.values()) w.close()
    for (const t of this.#timers.values()) clearTimeout(t)
    this.#watchers.clear()
    this.#timers.clear()
  }

  /**
   * A watch on a folder that gets deleted goes quiet without an error; the only
   * sign is an event named after the folder itself. Watch it again once it is back.
   */
  #replaced(dir: string) {
    this.#watchers.get(dir)?.close()
    this.#watchers.delete(dir)
    clearTimeout(this.#timers.get(dir))
    this.#timers.set(
      dir,
      setTimeout(() => {
        this.#timers.delete(dir)
        this.watch(dir)
        this.#on.replaced?.(dir)
      }, 200),
    )
  }

  #drop(dir: string) {
    this.#watchers.get(dir)?.close()
    this.#watchers.delete(dir)
    this.#on.dropped?.(dir)
  }
}
