import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, closeChats, resetFixture, WORK, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })

const SERVER = `
const http = require('node:http')
const s = http.createServer((req, res) => res.end('hi'))
s.listen(0, '127.0.0.1', () => console.log('PORT ' + s.address().port))
`
let child: ChildProcess | null = null

/** A real HTTP server running in ~/alpha/src, like `npm run dev` would. */
function startServer(): Promise<number> {
  child = spawn(process.execPath, ['-e', SERVER], { cwd: path.join(ALPHA, 'src'), stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve) => child!.stdout!.on('data', (d) => resolve(Number(/PORT (\d+)/.exec(String(d))?.[1]))))
}

test.beforeEach(async () => {
  await closeChats()
  await resetFixture()
})

test.afterEach(() => {
  child?.kill('SIGKILL')
  child = null
})

test('servers: a project’s running server shows in the nav, the card and the page; Stop asks first', async ({ page }) => {
  fs.writeFileSync(WORK_FILE, WORK.replace('        path: ~/beta\n', '        path: ~/beta\n        servers:\n          - { name: api, url: "http://127.0.0.1:1/health" }\n'))
  const port = await startServer()
  await page.goto('/')
  await expect(entry(page, 'Alpha').locator('.server-mark')).toHaveAttribute('aria-label', '1 server running')
  await expect(entry(page, 'Beta').locator('.server-mark.down')).toHaveAttribute('aria-label', '1 down')

  await entry(page, 'Alpha').click()
  await page.getByRole('button', { name: '1 server running' }).click()
  await expect(page.locator('.crumbs')).toContainText('Servers')
  const alpha = page.getByRole('region', { name: 'Alpha' })
  await expect(alpha.locator('.server-row')).toContainText(`:${port}`)
  await expect(alpha.locator('.server-row')).toContainText('node')
  await expect(alpha.locator('.server-row')).toContainText('200 OK')
  await expect(alpha.getByRole('link', { name: `Open ${port}` })).toHaveAttribute('href', `http://127.0.0.1:${port}/`)
  const beta = page.getByRole('region', { name: 'Beta' })
  await expect(beta.locator('.server-row')).toContainText('api')
  await expect(beta.locator('.server-dot.down')).toBeVisible()
  await page.screenshot({ path: 'test-results/servers-page.png' })

  const exited = new Promise((r) => child!.on('exit', r))
  await alpha.getByRole('button', { name: `Stop ${port}` }).click()
  await expect(page.getByRole('alertdialog')).toContainText(`Stop node on :${port}?`)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click()
  await exited
  await expect(page.locator('.toast').last()).toContainText(`Stopped node on :${port}`)
  await expect(page.getByRole('region', { name: 'Alpha' })).toHaveCount(0)
  await expect(page.locator('.servers-quiet')).toContainText('Alpha')
  await expect(entry(page, 'Alpha').locator('.server-mark')).toHaveCount(0)
})
