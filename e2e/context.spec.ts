import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeChats, NOTES, PERSONAL_FILE, PORT, resetFixture } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const context = (page: Page) => nav(page).getByRole('group', { name: 'Context' })
const row = (page: Page, name: string) => context(page).getByRole('link', { name: new RegExp(`^${name}`) })
const screen = (page: Page) => page.locator('.chat-terminal .xterm-rows')
const fileRow = (page: Page, name: string) => page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name, exact: true })

async function setUp(page: Page) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/context/setup`, {
    method: 'POST',
    headers: { 'x-workbench': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'work' }),
  })
  expect(res.ok).toBe(true)
  await page.reload()
  await expect(row(page, 'Inbox')).toBeVisible()
}

async function newChat(page: Page) {
  await entry(page, 'Alpha').click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(screen(page)).toContainText('FAKE CLAUDE')
}

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('Set up context from the nav; its notes open in tabs', async ({ page }) => {
  await page.screenshot({ path: 'test-results/context-setup-row.png' })
  await context(page).getByRole('button', { name: 'Set up context in ~/notes' }).click()
  await expect(page.locator('.page-title')).toHaveText('Context')
  await expect(row(page, 'Context')).toHaveAttribute('aria-current', 'page')
  for (const name of ['Knowledge', 'Processes', 'Inbox']) await expect(row(page, name)).toBeVisible()
  expect(await fsp.readFile(path.join(NOTES, 'context/README.md'), 'utf8')).toContain('context/preferences.md')

  await page.getByRole('tablist', { name: 'Context notes' }).getByRole('tab', { name: 'Where things go' }).click()
  await expect(page.locator('.markdown table')).toContainText('Remember how I want reports written')
  await page.getByRole('tablist', { name: 'Context notes' }).getByRole('tab', { name: 'Preferences' }).click()
  await expect(page.locator('.markdown h2').first()).toHaveText('Writing')
  await page.screenshot({ path: 'test-results/context-notes.png' })

  await row(page, 'Knowledge').click()
  await expect(page.locator('.crumbs')).toContainText('Context/Knowledge')
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
})

test('a profile without a notes folder gets one when context is set up', async ({ page }) => {
  await page.getByRole('tab', { name: 'Personal' }).click()
  await context(page).getByRole('button', { name: 'Set up context in ~/notes' }).click()
  await expect(row(page, 'Inbox')).toBeVisible()
  expect(await fsp.readFile(PERSONAL_FILE, 'utf8')).toContain('notes: ~/notes')
})

test('a new claude chat starts with the context folders and says so', async ({ page }) => {
  await setUp(page)
  await newChat(page)
  await expect(screen(page)).toContainText(`"--add-dir","${NOTES}/context"`)
  await expect(page.locator('.chat-bar .chat-context')).toHaveText('context')
})

test('Send to inbox copies a file; the badge counts it and the inbox lists it', async ({ page }) => {
  await setUp(page)
  await entry(page, 'Alpha').click()
  await fileRow(page, 'README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Send to inbox' }).click()
  await expect(page.locator('.toast')).toContainText('Copied to the inbox as README.md')
  await expect(row(page, 'Inbox').locator('.inbox-count')).toHaveText('1')
  await page.screenshot({ path: 'test-results/context-inbox-badge.png' })
  await page.locator('.toast').getByRole('button', { name: 'Open inbox' }).click()
  await expect(page.locator('.crumbs')).toContainText('Context/Inbox')
  await expect(fileRow(page, 'README.md')).toBeVisible()
})

test('Summarize and continue keeps the handoff in the inbox', async ({ page }) => {
  await setUp(page)
  await newChat(page)
  await page.locator('.chat-terminal').click()
  await page.keyboard.type('fix the parser')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText('you said: fix the parser')
  await page.getByRole('button', { name: /Summarize and continue/ }).click()
  await expect(screen(page)).toContainText('SUMMARY of')
  await expect(row(page, 'Inbox').locator('.inbox-count')).toHaveText('1')
  await row(page, 'Inbox').click()
  await expect(page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: /Fake Claude\.md$/ })).toBeVisible()
  await page.screenshot({ path: 'test-results/context-inbox.png' })
})
