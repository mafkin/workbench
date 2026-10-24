// Run before every test file: nothing a test starts may reach the machine's own
// folders. A service built without `stateDir` or `thumbsDir` lands in a temp
// folder, and claude's files (fake-claude's transcripts, the sessions read back)
// come from each test's fake home, never from CLAUDE_CONFIG_DIR.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-env-'))
process.env.WORKBENCH_STATE_DIR = path.join(scratch, 'state')
process.env.XDG_STATE_HOME = path.join(scratch, 'xdg-state')
process.env.XDG_CACHE_HOME = path.join(scratch, 'cache')
delete process.env.CLAUDE_CONFIG_DIR

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))
