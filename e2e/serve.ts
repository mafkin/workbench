// The service on a throwaway config for the Playwright tests. Programs are not
// started; each launch is appended to a log the tests read.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { buildServer } from '../server/main.ts'
import { DIR, HOME, PORT, resetFixture, SPAWN_LOG } from './fixture.ts'

await fsp.rm(DIR, { recursive: true, force: true })
await resetFixture()

const spawn = ((command: string, args: string[]) => {
  fs.appendFileSync(SPAWN_LOG, `${[command, ...args].join(' ')}\n`)
  const child = Object.assign(new EventEmitter(), { unref() {} })
  setImmediate(() => child.emit('spawn'))
  return child
}) as any

const { app } = await buildServer({ configDir: DIR, port: PORT, home: HOME, spawn })
await app.listen({ host: '127.0.0.1', port: PORT })
