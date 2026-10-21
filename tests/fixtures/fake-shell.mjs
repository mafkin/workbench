#!/usr/bin/env node
// A stand-in for the login shell in tests: prints how it started, echoes commands.
import readline from 'node:readline'

process.stdout.write(`FAKE SHELL cwd=${process.cwd()} args=${JSON.stringify(process.argv.slice(2))}\r\n$ `)
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line.trim() === 'exit') process.exit(0)
  process.stdout.write(`ran: ${line.trim()}\r\n$ `)
})
process.on('SIGHUP', () => process.exit(0))
