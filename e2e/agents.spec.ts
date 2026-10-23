import fsp from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, closeChats, page as wikiPage, resetFixture, WORK, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const chatTabs = (page: Page) => tabs(page).locator('.chat-tab')
const screen = (page: Page) => page.locator('.chat-terminal .xterm-rows')
const row = (page: Page, name: string) => page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name, exact: true })
const wikiText = (rel: string) => fsp.readFile(wikiPage(rel), 'utf8')

const AGENTS = `# How claude starts
agents:
  Reviewer:
    model: opus
    permission: plan
`

async function withWork(page: Page, text: string) {
  await writeWork(text)
  await page.reload()
  await expect(entry(page, 'Alpha')).toBeVisible()
}

const withAgents = (page: Page, text = WORK) => withWork(page, text.replace('sections:\n', `${AGENTS}sections:\n`))

async function startMenu(page: Page) {
  await page.getByRole('button', { name: 'More kinds of chat' }).click()
}

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('the editor adds an agent profile as a page in agents/', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await startMenu(page)
  await page.getByRole('menuitem', { name: 'Agent profiles…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Agent profiles' })
  const form = dialog.getByRole('form', { name: 'New agent profile' })
  await form.locator('input[name=name]').fill('Reviewer')
  await form.locator('input[name=model]').fill('opus')
  await form.locator('select[name=permission]').selectOption('plan')
  await form.locator('textarea[name=instructions]').fill('Review only.')
  await form.locator('textarea[name=allowedTools]').fill('Read\nGrep')
  await form.getByRole('button', { name: 'Add' }).click()
  await expect(dialog.getByRole('option', { name: /Reviewer/ })).toContainText('opus · plan')
  await expect(dialog.getByRole('form', { name: 'Agent profile Reviewer' })).toBeVisible()

  expect(await wikiText('agents/Reviewer.md')).toBe('---\nmodel: opus\npermission: plan\nallowedTools:\n  - Read\n  - Grep\n---\nReview only.\n')
  await page.screenshot({ path: 'test-results/agents-editor.png' })
})

test('New chat ▾ starts an agent profile with its flags; the bar says which', async ({ page }) => {
  await withAgents(page)
  await entry(page, 'Alpha').click()
  await startMenu(page)
  await expect(page.getByRole('menuitem', { name: /^Reviewer/ })).toContainText('opus · plan')
  await page.screenshot({ path: 'test-results/agents-menu.png' })
  await page.getByRole('menuitem', { name: /^Reviewer/ }).click()
  // The wiki comes with every claude chat (--append-system-prompt and --add-dir), before the session flag.
  await expect(screen(page)).toContainText('args=["--model","opus","--permission-mode","plan","--append-system-prompt"')
  await expect(page.locator('.chat-bar')).toContainText('Reviewer · opus · plan')
  // Plain Claude from the same menu has no flags.
  await startMenu(page)
  await page.getByRole('menuitem', { name: /^Claude/ }).click()
  await expect(chatTabs(page)).toHaveCount(2)
  await expect(screen(page)).toContainText('args=["--append-system-prompt"')
})

test("the project's agent chip sets what New chat starts", async ({ page }) => {
  await withAgents(page)
  await entry(page, 'Alpha').click()
  await page.getByRole('button', { name: 'Agent for New chat: Claude' }).click()
  await page.getByRole('menuitem', { name: /^Reviewer/ }).click()
  await expect(page.getByRole('button', { name: 'Agent for New chat: Reviewer' })).toBeVisible()
  expect(await wikiText('projects/Alpha.md')).toContain('agent: Reviewer\n')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(screen(page)).toContainText('"--model","opus"')
  await page.screenshot({ path: 'test-results/agents-chip.png' })
})

test('a chat step and Chat here as… start agent profiles', async ({ page }) => {
  await withAgents(page, WORK.replace('  - { label: build, type: launch, command: make, args: [all] }\n', '  - { label: review, type: chat, agent: Reviewer }\n'))
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('tab', { name: 'review' }).click()
  await expect(screen(page)).toContainText('"--model","opus","--permission-mode","plan"')

  await tabs(page).getByRole('tab', { name: 'All files' }).click()
  await row(page, 'src').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Chat here as…' }).click()
  await page.getByRole('menuitem', { name: /^Reviewer/ }).click()
  await expect(screen(page)).toContainText(`FAKE CLAUDE cwd=${ALPHA}/src`)
  await expect(screen(page)).toContainText('"--model","opus"')
})

test('bypassing permissions warns in the editor and marks its chats', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await startMenu(page)
  await page.getByRole('menuitem', { name: 'Agent profiles…' }).click()
  const form = page.getByRole('form', { name: 'New agent profile' })
  await form.locator('input[name=name]').fill('Wild')
  await form.locator('input[name=agent]').fill('orchestrator')
  await expect(form.locator('input[name=model]')).toBeDisabled()
  await form.locator('select[name=permission]').selectOption('bypassPermissions')
  await expect(form.getByRole('alert')).toContainText('without asking')
  await form.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await startMenu(page)
  await page.getByRole('menuitem', { name: /^Wild/ }).click()
  await expect(screen(page)).toContainText('args=["--agent","orchestrator","--permission-mode","bypassPermissions"')
  await expect(chatTabs(page).first().locator('.bypass-mark')).toBeVisible()
  await expect(page.locator('.chat-bar .bypass-note')).toBeVisible()
  await page.screenshot({ path: 'test-results/agents-bypass.png' })
})

test('renaming an agent profile renames what uses it; one in use cannot be deleted', async ({ page }) => {
  await withAgents(page, WORK.replace('        path: ~/alpha\n', '        path: ~/alpha\n        agent: Reviewer\n'))
  await entry(page, 'Alpha').click()
  await page.getByRole('button', { name: 'Agent for New chat: Reviewer' }).click()
  await page.getByRole('menuitem', { name: 'Agent profiles…' }).click()
  const form = page.getByRole('form', { name: 'Agent profile Reviewer' })
  await form.getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.toast')).toContainText('Reviewer is used by Alpha')

  await form.locator('input[name=name]').fill('Critic')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('form', { name: 'Agent profile Critic' })).toBeVisible()
  expect(await wikiText('agents/Critic.md')).toContain('model: opus')
  expect(await wikiText('projects/Alpha.md')).toContain('agent: Critic\n')
})
