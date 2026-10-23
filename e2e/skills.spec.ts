import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeChats, NOTES, page as wikiPage, resetFixture, WORK_FILE, writeClaudeSetup } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const rail = (page: Page) => page.getByRole('complementary', { name: 'Drawer tools' })
const rows = (page: Page) => page.getByRole('listbox').getByRole('option')
const option = (page: Page, name: string) => rows(page).filter({ has: page.locator('.setup-row-title', { hasText: new RegExp(`^${name}$`) }) })
const details = (page: Page) => page.getByLabel('Details')
const strip = (page: Page) => page.getByLabel('Pinned skills')
const screen = (page: Page) => page.locator('.chat-terminal .xterm-rows')
const chip = (page: Page) => page.getByRole('button', { name: /^Skills for chats here:/ })

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await writeClaudeSetup()
  // A skill of the wiki's own, loaded only where it is pinned.
  await fsp.mkdir(path.join(NOTES, 'skills/concept-art'), { recursive: true })
  await fsp.writeFile(path.join(NOTES, 'skills/concept-art/SKILL.md'), '---\nname: concept-art\ndescription: Prompts for concept art\n---\n# Concept art\n')
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('the rail pins a skill to the drawer; the card pins one to the page; a chat is told both and loads the wiki’s', async ({ page }) => {
  // The rail's Skills view lists the wiki's skill with its own badge; Pin writes the drawer's list (index.md here).
  await rail(page).getByRole('button', { name: 'Skills', exact: true }).click()
  await expect(strip(page)).toContainText('Nothing pinned yet')
  await expect(option(page, '/concept-art').locator('.scope-badge')).toHaveText('Wiki')
  await option(page, '/review').click()
  await details(page).getByRole('button', { name: 'Pin to Work' }).click()
  await expect(strip(page)).toContainText('review')
  await expect(details(page).getByRole('button', { name: 'Unpin from Work' })).toBeVisible()
  await expect.poll(() => fsp.readFile(WORK_FILE, 'utf8')).toContain('skills:\n  - review\n')
  await page.screenshot({ path: 'test-results/skills-rail.png' })

  // The card's chip lists every skill; ticking the wiki's pins it on Alpha's page.
  await entry(page, 'Alpha').click()
  await expect(chip(page)).toHaveText('Skills')
  await chip(page).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitemcheckbox', { name: '/review' })).toHaveAttribute('aria-checked', 'false')
  await menu.getByRole('menuitemcheckbox', { name: '/concept-art' }).click()
  await expect(chip(page)).toHaveText('concept-art')
  await expect.poll(() => fsp.readFile(wikiPage('projects/Alpha.md'), 'utf8')).toContain('skills:\n  - concept-art\n')
  await page.screenshot({ path: 'test-results/skills-chip.png' })

  // A chat from the page is told both, and loads the wiki skill as a plugin.
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(screen(page)).toContainText('"--plugin-dir"')
  await expect(screen(page)).toContainText('/wiki:concept-art: Prompts for concept art')
  await expect(screen(page)).toContainText('/review: Reviews a change before it ships')

  // Unpin from the chip's menu: the key goes.
  await chip(page).click()
  await page.getByRole('menu').getByRole('menuitemcheckbox', { name: '/concept-art' }).click()
  await expect(chip(page)).toHaveText('Skills')
  await expect.poll(() => fsp.readFile(wikiPage('projects/Alpha.md'), 'utf8')).not.toContain('skills:')
})
