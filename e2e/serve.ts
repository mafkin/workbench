// The service on a throwaway config for the Playwright tests. Programs are not
// started; each launch is appended to a log the tests read. `gio trash` moves
// files into the fixture's trash folder instead, so tests can see where they went.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { buildServer } from '../server/main.ts'
import { DIR, HOME, PORT, resetFixture, SPAWN_LOG, TRASH } from './fixture.ts'

await fsp.rm(DIR, { recursive: true, force: true })
await resetFixture()

const spawn = ((command: string, args: string[]) => {
  fs.appendFileSync(SPAWN_LOG, `${[command, ...args].join(' ')}\n`)
  if (command === 'gio' && args[0] === 'trash') {
    fs.mkdirSync(TRASH, { recursive: true })
    for (const p of args.slice(2)) fs.renameSync(p, path.join(TRASH, path.basename(p)))
  }
  const child = Object.assign(new EventEmitter(), { unref() {}, stderr: new EventEmitter() })
  setImmediate(() => {
    child.emit('spawn')
    child.emit('close', 0)
  })
  return child
}) as any

const { app } = await buildServer({ configDir: DIR, port: PORT, home: HOME, spawn })
await app.listen({ host: '127.0.0.1', port: PORT })
