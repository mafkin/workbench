#!/usr/bin/env node
// A stand-in for the claude CLI in tests: no network, no model. It prints what it
// was started with, echoes what you type, keeps a transcript where claude would,
// rings the bell on "ring", works for a while on "work", and answers -p with a
// canned summary.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const VALUED = new Set(['--session-id', '--resume', '-r', '--model', '--add-dir', '-n', '--name'])
const positional = argv.filter((a, i) => !a.startsWith('-') && !VALUED.has(argv[i - 1]))
const resume = flag('--resume')
const session = resume ?? flag('--session-id') ?? 'none'
const cwd = process.cwd()
const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude')
const transcript = path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`)

if (argv.includes('-p') || argv.includes('--print')) {
  process.stdout.write(`SUMMARY of ${session}: fixed the parser; next, the tests.\n`)
  process.exit(0)
}

const record = (text) => {
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  const line = { type: 'user', cwd, sessionId: session, message: { role: 'user', content: text }, timestamp: new Date().toISOString() }
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`)
}

process.stdout.write('\x1b]0;✳ Fake Claude\x07')
process.stdout.write(`FAKE CLAUDE cwd=${cwd}\r\n`)
process.stdout.write(`session=${session} resumed=${!!resume}\r\n`)
process.stdout.write(`args=${JSON.stringify(argv.filter((a) => !positional.includes(a)))}\r\n`)
if (positional.length) {
  process.stdout.write(`prompt=${positional.join(' ').replace(/\n/g, ' | ')}\r\n`)
  record(positional.join(' '))
}
process.stdout.write('> ')

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (text === 'exit') process.exit(0)
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
