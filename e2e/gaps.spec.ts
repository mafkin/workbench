import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, closeChats, NOTES, PORT, resetFixture, TRASH, WORK, WORK_FILE, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tree = (page: Page) => page.getByRole('tree', { name: 'Files' })
const row = (page: Page, name: string | RegExp) => tree(page).getByRole('treeitem', { name, exact: typeof name === 'string' })
const menu = (page: Page, name: string | RegExp) => page.getByRole('menuitem', { name })
const screen = (page: Page) => page.locator('.chat-terminal .xterm-rows')

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('notes: tick a task in View, coloured code, and a link to another note’s heading', async ({ page }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Line ${i}`).join('\n\n')
  await fsp.writeFile(path.join(NOTES, 'work/Deploy plan.md'), `# Deploy plan\n\n${filler}\n\n## Rollback\n\nRevert the tag.\n`)
  await fsp.appendFile(path.join(NOTES, 'Ideas.md'), '\nSee [[Deploy plan#Rollback]].\n\n```js\nconst answer = 42 // the answer\n```\n')
  await entry(page, 'Ideas').click()
  const md = page.locator('.markdown')
  await expect(md.locator('.tok-keyword').first()).toHaveText('const')
  await expect(md.locator('.tok-comment')).toHaveText('// the answer')

  await md.getByRole('checkbox', { name: 'Mark done' }).click()
  await expect.poll(() => fs.readFileSync(path.join(NOTES, 'Ideas.md'), 'utf8')).toContain('- [x] Wiki links')
  await page.screenshot({ path: 'test-results/gaps-notes.png' })

  await md.getByRole('link', { name: /Deploy plan › Rollback/ }).click()
  await expect(page.locator('.crumbs')).toContainText('Deploy plan')
  await expect(page.locator('#h-rollback')).toBeInViewport()
})

test('files: duplicate, copy and paste, search closed folders, sizes, and Undo for Trash', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await row(page, 'README.md').click({ button: 'right' })
  await menu(page, 'Duplicate').click()
  await expect(row(page, 'README copy.md')).toBeVisible()

  await row(page, 'build.log').click()
  await page.keyboard.press('Control+c')
  await row(page, 'reports').click()
  await page.keyboard.press('Control+v')
  await expect(page.locator('.toast').last()).toContainText('Copied build.log to reports')
  expect(fs.existsSync(path.join(ALPHA, 'reports/build.log'))).toBe(true)

  await row(page, 'build.log').click()
  await page.keyboard.press('Delete')
  await expect(row(page, 'build.log')).toHaveCount(0)
  expect(fs.existsSync(path.join(TRASH, 'build.log'))).toBe(true)
  await page.locator('.toast', { hasText: 'Moved build.log to Trash' }).getByRole('button', { name: 'Undo' }).click()
  await expect(row(page, 'build.log')).toBeVisible()
  expect(fs.readFileSync(path.join(ALPHA, 'build.log'), 'utf8')).toBe('built\n')

  await page.getByLabel('Filter by name').fill('util')
  await page.getByRole('button', { name: /Search all folders for “util”/ }).click()
  await expect(row(page, 'util.py')).toContainText('src')
  await page.getByRole('button', { name: 'Back to the tree' }).click()
  await page.getByLabel('Filter by name').fill('')

  await row(page, 'src').click({ button: 'right' })
  await menu(page, 'Compute size').click()
  await expect(row(page, 'src').locator('.file-size')).toHaveText(/\d+ B/)
  await page.screenshot({ path: 'test-results/gaps-files.png' })
})

test('files: a file dropped from the desktop lands in the folder', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await expect(row(page, 'src')).toBeVisible()
  await page.evaluate(() => {
    const target = document.querySelector('[role=treeitem][aria-label="src"]')!
    const data = new DataTransfer()
    data.items.add(new File(['dropped bytes'], 'dropped.txt', { type: 'text/plain' }))
    for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.toast').last()).toContainText('Added dropped.txt to src')
  await expect.poll(() => fs.existsSync(path.join(ALPHA, 'src/dropped.txt'))).toBe(true)
  expect(fs.readFileSync(path.join(ALPHA, 'src/dropped.txt'), 'utf8')).toBe('dropped bytes')
})

test('files: a huge folder draws only the rows in view', async ({ page }) => {
  const big = path.join(ALPHA, 'big')
  await fsp.mkdir(big)
  for (let i = 0; i < 1500; i++) await fsp.writeFile(path.join(big, `file-${String(i).padStart(4, '0')}.txt`), '')
  await entry(page, 'Alpha').click()
  await row(page, 'big').dblclick()
  await expect(row(page, 'file-0000.txt')).toBeVisible()
  expect(await tree(page).getByRole('treeitem').count()).toBeLessThan(400)
  await page.locator('.content').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(row(page, 'file-1499.txt')).toBeVisible()
})

test('cards: a category’s colour from the card, and the project’s dates', async ({ page }) => {
  await writeWork(WORK.replace('        path: ~/alpha\n', '        path: ~/alpha\n        category: Games\n'))
  await page.reload()
  await entry(page, 'Alpha').click()
  await expect(page.locator('.card-dates')).toContainText(/Created .* · Updated/)
  await page.locator('.category-chip').click()
  await menu(page, 'Colour of Games…').click()
  await menu(page, 'Sand').click()
  await expect.poll(() => fs.readFileSync(WORK_FILE, 'utf8')).toMatch(/categories:\n\s+Games: "#b39b78"/)
  await expect(page.locator('.category-chip')).toHaveAttribute('style', /#b39b78/)
})

test('nav: a broken file pauses the pencil; chats follow /clear', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(screen(page)).toContainText('FAKE CLAUDE')
  await page.locator('.chat-terminal').click()
  await page.keyboard.type('clear')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText('cleared: session=')
  const cleared = /cleared: session=([0-9a-f-]{36})/.exec((await screen(page).textContent()) ?? '')![1]
  await expect
    .poll(async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/chats?profile=work`, { headers: { 'x-workbench': '1' } })
      return ((await res.json()) as { session: string }[])[0]?.session
    })
    .toBe(cleared)

  await fsp.writeFile(WORK_FILE, '---\nname: [oops\n---\n')
  await expect(nav(page).getByRole('alert')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit navigation' })).toBeDisabled()
})
