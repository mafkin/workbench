import fsp from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { page as wikiPage, resetFixture, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const rail = (page: Page) => page.getByRole('complementary', { name: 'Drawer tools' })
const tool = (page: Page, name: string) => rail(page).getByRole('button', { name, exact: true })
const title = (page: Page) => page.locator('.page-title')

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('the rail: every drawer has Files on its own folder from the start; Settings points the tools at another folder', async ({ page }) => {
  // The drawer's own folder, drawers/Work in the profile, is there from the start.
  await expect(rail(page).getByRole('button')).toHaveText(['Files', 'Git', 'Skills', 'MCP', 'Settings'])
  await tool(page, 'Files').click()
  await expect(page.getByRole('navigation', { name: 'Path' })).toContainText('Work')
  await tool(page, 'Drawer settings').click()
  await expect(title(page)).toHaveText('Drawer settings')
  await expect(tool(page, 'Drawer settings')).toHaveAttribute('aria-pressed', 'true')
  const form = page.getByRole('form', { name: 'Drawer settings' })
  await form.locator('input[name=drawerFolder]').fill('~/alpha')
  await form.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.toast')).toContainText('Drawer Work saved')
  // The profile's one drawer became a page, with the folder.
  await expect.poll(() => fsp.readFile(wikiPage('drawers/Work.md'), 'utf8').catch(() => '')).toContain('folder: ~/alpha')
  expect(await fsp.readFile(WORK_FILE, 'utf8')).toContain('## Drawers')
  await expect(rail(page).getByRole('button')).toHaveText(['Files', 'Git', 'Skills', 'MCP', 'Settings'])
  await page.screenshot({ path: 'test-results/rail-settings.png' })

  await tool(page, 'Files').click()
  await expect(title(page)).toHaveText('Files')
  await expect(page.locator('.page-kicker')).toHaveText('Work')
  await expect(page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md' })).toBeVisible()

  await tool(page, 'Git').click()
  await expect(title(page)).toHaveText('Git')
  await expect(page.locator('.git-view')).toContainText('main')
  await page.screenshot({ path: 'test-results/rail-git.png' })

  // Ctrl+K lists the drawer's tools; the selection survives a reload.
  await page.keyboard.press('Control+k')
  await page.keyboard.type('mcp')
  await page.getByRole('dialog', { name: 'Quick switcher' }).getByRole('option', { name: /MCP servers/ }).first().click()
  await expect(title(page)).toHaveText('MCP servers')
  await expect(page.locator('.setup-for')).toContainText('~/alpha')
  await page.reload()
  await expect(title(page)).toHaveText('MCP servers')
  await expect(tool(page, 'MCP')).toHaveAttribute('aria-pressed', 'true')
})
