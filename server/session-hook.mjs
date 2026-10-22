#!/usr/bin/env node
// claude's SessionStart hook for Workbench chats: it runs when a session
// starts, resumes or is cleared (/clear, /resume), and writes the session id to
// <WORKBENCH_HOOK_DIR>/<WORKBENCH_CHAT>.json so the chat's tab follows it.
// It prints nothing: what a SessionStart hook prints goes into claude's context.
import fs from 'node:fs'
import path from 'node:path'

const chat = process.env.WORKBENCH_CHAT
const dir = process.env.WORKBENCH_HOOK_DIR
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  try {
    const { session_id: session, source } = JSON.parse(input)
    if (chat && dir && /^[\w-]+$/.test(chat) && /^[0-9a-f-]{36}$/i.test(session)) {
      const file = path.join(dir, `${chat}.json`)
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ session, source, at: Date.now() }))
      fs.renameSync(`${file}.tmp`, file)
    }
  } catch {
    // Never in claude's way.
  }
  process.exit(0)
})
