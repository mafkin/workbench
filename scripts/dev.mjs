// Dev mode: the service (restarts on change) on 7420 and Vite with HMR on 7421.
import { spawn } from 'node:child_process'

const procs = [
  spawn('node', ['--watch', 'server/main.ts', '--dev'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
]
const stop = () => procs.forEach((p) => p.kill('SIGTERM'))
for (const p of procs) p.on('exit', stop)
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
