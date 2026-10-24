import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, closeChats, page as wikiPage, resetFixture, WORK, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })
// Chats live in the dock (part 12): every chat of the profile, pinned first, then the newest first.
const dock = (page: Page) => page.getByRole('complementary', { name: 'Chats' })
const chatTabs = (page: Page) => dock(page).getByRole('tab')
const screen = (page: Page) => page.locator('.chat-terminal .xterm-rows')
const row = (page: Page, name: string) => page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name, exact: true })

async function typeInChat(page: Page, text: string) {
  await page.locator('.chat-terminal').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function newChat(page: Page) {
  await dock(page).getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(screen(page)).toContainText('FAKE CLAUDE')
}

async function withWork(page: Page, from: string, to: string) {
  await writeWork(WORK.replace(from, to))
  await page.reload()
}

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('New chat runs claude in the project; typing reaches it; the tab takes its title', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await expect(screen(page)).toContainText(`FAKE CLAUDE cwd=${ALPHA}`)
  await expect(chatTabs(page)).toHaveText(['Fake Claude'])
  await expect(chatTabs(page).first()).toHaveAttribute('aria-selected', 'true')
  await typeInChat(page, 'hello there')
  await expect(screen(page)).toContainText('you said: hello there')
  await expect(page.locator('.chat-bar')).toContainText('~/alpha')
  await expect(entry(page, 'Alpha').locator('.chat-mark')).toBeVisible()
  // The page stays on the project; the chat is beside it.
  await expect(page.locator('.page-title')).toHaveText('Alpha')
  await page.screenshot({ path: 'test-results/chat-tab.png' })
})

test('a chat keeps running across a reload, and its screen comes back', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await typeInChat(page, 'before the reload')
  await expect(screen(page)).toContainText('you said: before the reload')
  await page.reload()
  await expect(chatTabs(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(screen(page)).toContainText('you said: before the reload')
  await typeInChat(page, 'after')
  await expect(screen(page)).toContainText('you said: after')
})

test('a chat step starts when first opened; a shell step runs the login shell in its folder', async ({ page }) => {
  await withWork(page, '  - { label: build, type: launch, command: make, args: [all] }\n', '  - { label: agent, type: chat }\n  - { label: term, type: chat, agent: shell, path: src }\n')
  await entry(page, 'Alpha').click()
  await tab(page, 'agent').click()
  await expect(screen(page)).toContainText(`FAKE CLAUDE cwd=${ALPHA}`)
  await tab(page, 'term').click()
  await expect(screen(page)).toContainText(`FAKE SHELL cwd=${ALPHA}/src args=["-l"]`)
  await typeInChat(page, 'make test')
  await expect(screen(page)).toContainText('ran: make test')
  // Back to the step: the same chat, not a new one. The dock lists the steps' chats too.
  await tab(page, 'agent').click()
  await expect(screen(page).first()).toContainText(`FAKE CLAUDE cwd=${ALPHA}`)
  await expect(chatTabs(page)).toHaveText(['term', 'agent'])
})

test('closing a running chat asks first; History lists its session and resumes it', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await typeInChat(page, 'plan the release')
  await expect(screen(page)).toContainText('you said: plan the release')
  await chatTabs(page).first().hover()
  await page.getByRole('button', { name: 'Close Fake Claude' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('stays in History')
  await confirm.getByRole('button', { name: 'Close' }).click()
  await expect(chatTabs(page)).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('its session stays in History')

  await dock(page).getByRole('button', { name: 'History' }).click()
  await page.getByRole('menuitem', { name: /plan the release/ }).click()
  await expect(screen(page)).toContainText('resumed=true')
  await expect(chatTabs(page)).toHaveCount(1)
  await page.screenshot({ path: 'test-results/chat-history.png' })
})

test('chats can be renamed, coloured and pinned from the tab menu', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await newChat(page)
  await expect(chatTabs(page)).toHaveCount(2)
  const second = chatTabs(page).nth(1)
  await second.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.getByRole('textbox', { name: 'Chat name' }).fill('parser')
  await page.keyboard.press('Enter')
  await expect(chatTabs(page)).toHaveText(['Fake Claude', 'parser'])

  await chatTabs(page).nth(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Colour…' }).click()
  await page.getByRole('menuitem', { name: 'Sage' }).click()
  await expect(chatTabs(page).nth(1)).toHaveClass(/colored/)

  await chatTabs(page).nth(1).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await expect(chatTabs(page)).toHaveText(['parser', 'Fake Claude'])
  await expect(chatTabs(page).first().getByRole('button', { name: /Close/ })).toHaveCount(0)
})

test('a chat that goes quiet after working marks the dock and the nav until you look', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await typeInChat(page, 'work')
  // Hidden, the chat is not looked at: the strip and the nav say it needs you.
  await dock(page).getByRole('button', { name: 'Hide chats' }).click()
  await expect(dock(page).locator('.attention')).toBeVisible()
  await expect(entry(page, 'Alpha').locator('.chat-mark.attention')).toBeVisible()
  await page.screenshot({ path: 'test-results/chat-needs-you.png' })
  await dock(page).getByRole('button', { name: /^Show chats/ }).click()
  await expect(screen(page)).toContainText('done')
  await expect(entry(page, 'Alpha').locator('.chat-mark.attention')).toHaveCount(0)
  // Ctrl+J hides and shows it too.
  await page.locator('.page-title').click()
  await page.keyboard.press('Control+j')
  await expect(dock(page).getByRole('button', { name: /^Show chats/ })).toBeVisible()
  await page.keyboard.press('Control+j')
  await expect(chatTabs(page)).toHaveCount(1)
})

test('a file dragged onto a chat tab is typed into its prompt', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await tab(page, 'All files').click()
  await row(page, 'README.md').dragTo(chatTabs(page).first())
  await expect(chatTabs(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(screen(page)).toContainText(path.join(ALPHA, 'README.md'))
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(`you said: ${path.join(ALPHA, 'README.md')}`)
})

test('Summarize and continue opens a new chat seeded with the summary', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await newChat(page)
  await typeInChat(page, 'fix the parser')
  await expect(screen(page)).toContainText('you said: fix the parser')
  await page.getByRole('button', { name: /Summarize and continue/ }).click()
  await expect(chatTabs(page)).toHaveCount(2)
  await expect(chatTabs(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(screen(page)).toContainText('SUMMARY of')
})

test('Chat here and Shell here start in a folder of the project', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await row(page, 'src').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Chat here' }).click()
  await expect(screen(page)).toContainText(`FAKE CLAUDE cwd=${ALPHA}/src`)
  await tab(page, 'All files').click()
  await row(page, 'src').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Shell here' }).click()
  await expect(screen(page)).toContainText(`FAKE SHELL cwd=${ALPHA}/src`)
  await expect(chatTabs(page)).toHaveText(['Shell', 'Fake Claude'])
})

test('a chat entry in the nav has its own page; New chat from the nav menu opens in the project', async ({ page }) => {
  await withWork(page, '        args: [hello]\n', '        args: [hello]\n      - { label: Scratch, type: chat, path: ~/alpha }\n')
  await entry(page, 'Scratch').click()
  await expect(page.locator('.page-title')).toHaveText('Scratch')
  await expect(screen(page)).toContainText(`FAKE CLAUDE cwd=${ALPHA}`)
  await expect(entry(page, 'Scratch').locator('.chat-mark')).toBeVisible()

  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New shell' }).click()
  await expect(page.locator('.page-title')).toContainText('Alpha')
  await expect(chatTabs(page)).toHaveText(['Shell', 'Scratch'])
  await expect(screen(page)).toContainText('FAKE SHELL')

  // A project whose folder is missing says so instead of starting anything.
  await entry(page, 'Beta').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New chat' }).click()
  await expect(page.locator('.toast')).toContainText('The folder ~/beta does not exist')
})

test('the dialog adds a chat step with an agent', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'Add step' }).click()
  const dialog = page.getByRole('form', { name: 'Add step' })
  await dialog.getByRole('radio', { name: 'Chat' }).click()
  await dialog.getByRole('radio', { name: 'Shell' }).click()
  await dialog.locator('input[name=label]').fill('term')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(tab(page, 'term')).toBeVisible()
  expect(await fsp.readFile(wikiPage('pages/Alpha.md'), 'utf8')).toContain('- [term](chat:shell)\n')
})
