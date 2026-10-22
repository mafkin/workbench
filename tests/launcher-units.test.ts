import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve('.')

describe('bin/workbench --print-units', () => {
  const out = execFileSync('bash', [path.join(ROOT, 'bin/workbench'), '--print-units'], {
    env: { ...process.env, HOME: '/home/u', XDG_CONFIG_HOME: '', XDG_STATE_HOME: '', WORKBENCH_PORT: '7420', PATH: `/opt/node/bin:${process.env.PATH}` },
    encoding: 'utf8',
  })
  const unit = (name: string) => out.split('# ==> ').find((b) => b.startsWith(`/home/u/.config/systemd/user/${name}\n`)) ?? ''

  it('writes a service that runs this checkout with node, restarting on failure', () => {
    const s = unit('workbench.service')
    expect(s).toContain(`WorkingDirectory=${ROOT}\n`)
    expect(s).toMatch(new RegExp(`ExecStart=/\\S+/node ${ROOT}/server/main.ts --port 7420\\n`))
    expect(s).toContain('Restart=on-failure')
    expect(s).toContain('Environment=PATH=/opt/node/bin:')
    expect(s).toContain('StandardOutput=append:/home/u/.local/state/workbench/server.log')
    expect(s).toContain('WantedBy=default.target')
  })

  it('rebuilds and restarts when the checkout moves', () => {
    expect(unit('workbench-update.path')).toContain(`PathChanged=${ROOT}/.git/logs/HEAD`)
    const u = unit('workbench-update.service')
    expect(u).toContain('Type=oneshot')
    expect(u).toContain(`ExecStart=${ROOT}/bin/workbench --update`)
  })
})
