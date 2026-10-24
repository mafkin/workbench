#!/usr/bin/env node
// A stand-in for the claude CLI in tests: no network, no model. It prints what it
// was started with, echoes what you type, keeps a transcript where claude would,
// rings the bell on "ring", works for a while on "work", and answers -p with a
// canned summary (or, asked for a commit message, one made from the diff on
// stdin). Runs SessionStart hooks from --settings, and "clear" starts a new
// session as /clear does.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
// Flags that take one value, and lists that take every word up to the next flag.
const VALUED = new Set(['--settings', '--session-id', '--resume', '-r', '--model', '-n', '--name', '--agent', '--effort', '--permission-mode', '--append-system-prompt'])
const LISTS = new Set(['--add-dir', '--allowedTools', '--disallowedTools', '--mcp-config', '--tools'])
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (VALUED.has(argv[i])) i++
  else if (LISTS.has(argv[i])) while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++
  else if (!argv[i].startsWith('-')) positional.push(argv[i])
}
const resume = flag('--resume')
let session = resume ?? flag('--session-id') ?? 'none'
const cwd = process.cwd()
const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')
const transcriptOf = (id) => path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)

// SessionStart hooks from --settings run as claude runs them: the event as JSON on stdin.
function sessionStart(source) {
  let settings = {}
  try {
    settings = JSON.parse(flag('--settings') ?? '{}')
  } catch {}
  for (const group of settings.hooks?.SessionStart ?? []) {
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command') continue
      const input = JSON.stringify({ session_id: session, transcript_path: transcriptOf(session), cwd, hook_event_name: 'SessionStart', source })
      try {
        execSync(hook.command, { input, stdio: ['pipe', 'ignore', 'ignore'] })
      } catch {}
    }
  }
}

if (argv.includes('-p') || argv.includes('--print')) {
  // A commit message: drafted from the diff on stdin, naming the first file and the tools flag.
  if (positional.join(' ').includes('commit message')) {
    const diff = fs.readFileSync(0, 'utf8')
    const file = /^diff --git a\/(\S+)/m.exec(diff)?.[1] ?? 'nothing'
    const tools = argv.includes('--tools') ? JSON.stringify(argv[argv.indexOf('--tools') + 1]) : 'default'
    process.stdout.write(`Update ${file}\n\nDrafted from ${diff.split('\n').length} lines; tools=${tools}.\n`)
    process.exit(0)
  }
  process.stdout.write(`SUMMARY of ${session}: fixed the parser; next, the tests.\n`)
  process.exit(0)
}

const record = (text) => {
  const transcript = transcriptOf(session)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const line = { type: 'user', cwd, sessionId: session, message: { role: 'user', content: text }, timestamp: new Date().toISOString() }
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`)
}

sessionStart(resume ? 'resume' : 'startup')
process.stdout.write('\x1b]0;✳ Fake Claude\x07')
process.stdout.write(`FAKE CLAUDE cwd=${cwd}\r\n`)
process.stdout.write(`session=${session} resumed=${!!resume}\r\n`)
const args = argv.filter((a) => !positional.includes(a))
process.stdout.write(`args=${JSON.stringify(args)}\r\n`)
// The prompt makes the args line long enough to scroll the banner away in a narrow terminal:
// say the essentials again, with long values shortened, so a screen read finds them.
process.stdout.write(`FAKE CLAUDE cwd=${cwd} resumed=${!!resume} short=${JSON.stringify(args.map((a) => (a.length > 80 ? `<${a.length} chars>` : a)))}\r\n`)
if (positional.length) {
  process.stdout.write(`prompt=${positional.join(' ').replace(/\n/g, ' | ')}\r\n`)
  record(positional.join(' '))
}
process.stdout.write('> ')

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === 'exit') process.exit(0)
  if (text === 'clear') {
    session = randomUUID()
    sessionStart('clear')
    process.stdout.write(`cleared: session=${session}\r\n> `)
    return
  }
  if (text === 'ring') process.stdout.write('\x07')
  if (text.startsWith('title ')) process.stdout.write(`\x1b]0;✳ ${text.slice(6)}\x07`)
  if (text === 'work') {
    let n = 0
    const t = setInterval(() => {
      process.stdout.write(`working ${++n}\r\n`)
      if (n >= 30) {
        clearInterval(t)
        process.stdout.write('done\r\n> ')
      }
    }, 50)
    return
  }
  if (text) record(text)
  process.stdout.write(`you said: ${text}\r\n> `)
})
process.on('SIGHUP', () => process.exit(0))
