#!/usr/bin/env node
// A stand-in MCP server over stdio for the setup checks: newline-delimited
// JSON-RPC on stdin and stdout, logs on stderr. FAKE_MCP_MODE picks how it
// behaves: ok (default), crash, hang (answers nothing, outlives its input, ignores
// SIGTERM and has a child of its own), garbage (non-JSON lines on stdout first),
// paged (tools in two pages), noinit (no initialize method).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

const mode = process.env.FAKE_MCP_MODE || 'ok'
if (process.env.FAKE_MCP_PIDFILE) fs.writeFileSync(process.env.FAKE_MCP_PIDFILE, String(process.pid))
process.stderr.write(`fake-mcp starting with token ${process.env.FAKE_MCP_TOKEN ?? '(none)'}\n`)

if (mode === 'crash') {
  process.stderr.write('fake-mcp: cannot reach the database\n')
  process.exit(3)
}
if (mode === 'hang') {
  // Only a KILL to its process group stops both (else they give up after 20 s, so a failed test leaves nothing behind).
  process.on('SIGTERM', () => {})
  setTimeout(() => process.exit(0), 20_000)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20_000)'], { stdio: 'ignore' })
  if (process.env.FAKE_MCP_PIDFILE) fs.writeFileSync(`${process.env.FAKE_MCP_PIDFILE}.child`, String(child.pid))
}
if (mode === 'garbage') process.stdout.write('Loading plugins...\nnot json either\n')

const TOOLS = [
  { name: 'echo', description: `Says it back. Greeting: ${(process.env.FAKE_MCP_GREETING ?? 'none').toUpperCase()}` },
  { name: 'add', description: 'Adds two numbers' },
  { name: 'cwd', description: `Runs in ${process.cwd()}` },
]

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
let initialized = false

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (mode === 'hang') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    if (mode === 'noinit') return send({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
    return send({
      id: msg.id,
      result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.2.3' } },
    })
  }
  if (msg.method === 'notifications/initialized') {
    initialized = true
    // A server may ask the client things; the checker should answer, not hang.
    send({ id: 'srv-1', method: 'ping' })
    return
  }
  if (msg.method === 'tools/list') {
    if (mode !== 'noinit' && !initialized) return send({ id: msg.id, error: { code: -32002, message: 'Not initialized' } })
    if (mode === 'paged') {
      const second = msg.params?.cursor === 'page-2'
      return send({ id: msg.id, result: second ? { tools: TOOLS.slice(2) } : { tools: TOOLS.slice(0, 2), nextCursor: 'page-2' } })
    }
    return send({ id: msg.id, result: { tools: TOOLS } })
  }
  if (msg.id !== undefined && msg.method) send({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
})
