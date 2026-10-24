import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, page as wikiPage, resetFixture, SPAWN_LOG } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })
// The item's own page is the first tab; Git and Claude setup are the rail's, not tabs.
const tabNames = async (page: Page) => (await tabs(page).locator('.step-tab:not(.add)').allInnerTexts()).map((t) => t.split('\n')[0].trim())
const row = (page: Page, name: string) => page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name, exact: true })
const alphaPage = () => fsp.readFile(wikiPage('pages/Alpha.md'), 'utf8')

async function stepMenu(page: Page, name: string, item: string) {
  await tabs(page).locator('.step-tab', { hasText: name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: item }).click()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('a project shows its workflow steps as tabs, and All files is the project', async ({ page }) => {
  await entry(page, 'Alpha').click()
  expect(await tabNames(page)).toEqual(['Page', 'All files', 'sources', 'readme', 'build'])
  await expect(tab(page, 'All files')).toHaveAttribute('aria-selected', 'true')
  await expect(row(page, 'README.md')).toBeVisible()
  await page.screenshot({ path: 'test-results/project-tabs.png' })
  // The Page tab is the project's own page: its frontmatter as properties, its text, and who mentions it.
  await tab(page, 'Page').click()
  await expect(page.locator('.note-props')).toContainText('folder')
  await expect(page.locator('.markdown h2')).toHaveText('Workflow')
  await expect(page.locator('.note-mentions')).toContainText('index')
  await page.screenshot({ path: 'test-results/project-page-tab.png' })
})

test('a folder step shows its folder, and the tab is remembered', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tab(page, 'sources').click()
  await expect(row(page, 'main.py')).toHaveAttribute('aria-level', '1')
  await expect(tab(page, 'sources')).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await expect(tab(page, 'sources')).toHaveAttribute('aria-selected', 'true')
  await expect(row(page, 'main.py')).toBeVisible()
})

test('a note step opens in place and saves', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tab(page, 'readme').click()
  await expect(page.locator('.markdown h1')).toHaveText('Alpha')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Written from the readme step.')
  await expect.poll(() => fsp.readFile(path.join(ALPHA, 'README.md'), 'utf8')).toContain('Written from the readme step.')
})

test('a launcher step starts in the project folder and stays on the tab', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'build' }).click()
  await expect(page.locator('.toast')).toContainText('Started build')
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe(`make all (in ${ALPHA})\n`)
  await expect(tab(page, 'All files')).toHaveAttribute('aria-selected', 'true')
})

test('adding a step writes the page’s Workflow, and a missing folder can be made', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'Add step' }).click()
  const dialog = page.getByRole('form', { name: 'Add step' })
  await expect(dialog.getByRole('radio')).toHaveCount(8)
  await dialog.locator('input[name=label]').fill('assets')
  await dialog.locator('input[name=path]').fill('art/assets')
  await expect(dialog).toContainText('Not found on disk')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await tabNames(page)).toEqual(['Page', 'All files', 'sources', 'readme', 'build', 'assets'])

  const text = await alphaPage()
  expect(text).toContain('---\nfolder: ~/alpha\n---\n')
  expect(text).toContain('## Workflow\n\n- [All files](files:)\n- [sources](src/)\n')
  expect(text).toContain('- [assets](art/assets/)\n')

  await tab(page, 'assets').click()
  await page.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.locator('.file-empty')).toHaveText('Empty folder')
  expect(fs.statSync(path.join(ALPHA, 'art/assets')).isDirectory()).toBe(true)
  await page.screenshot({ path: 'test-results/project-new-step.png' })
})

test('steps can be edited, reordered and removed, built-in ones too; Add profile steps brings back the missing ones', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await stepMenu(page, 'readme', 'Edit…')
  const dialog = page.getByRole('form', { name: 'Edit step' })
  await dialog.locator('input[name=label]').fill('intro')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(tab(page, 'intro')).toBeVisible()

  await tabs(page).getByRole('button', { name: 'build' }).dragTo(tab(page, 'sources'))
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'build', 'sources', 'intro'])

  await stepMenu(page, 'intro', 'Remove tab')
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'build', 'sources'])
  await expect(page.locator('.toast')).toContainText('its files stay')
  // The note itself is still there.
  expect(fs.existsSync(path.join(ALPHA, 'README.md'))).toBe(true)

  // A built-in tab goes the same way: Delete on the focused tab.
  await tab(page, 'All files').focus()
  await page.keyboard.press('Delete')
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'build', 'sources'])
  expect(await alphaPage()).not.toContain('files:')

  await stepMenu(page, 'sources', 'Add profile steps')
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'build', 'sources', 'readme'])
})

test('git: and setup: lines in a page (from before the rail) get no tab, and the other tabs still work by their own index', async ({ page }) => {
  const text = await alphaPage()
  await fsp.writeFile(wikiPage('pages/Alpha.md'), text.replace('- [All files](files:)\n', '- [All files](files:)\n- [Git](git:)\n- [Claude setup](setup:)\n'))
  await entry(page, 'Alpha').click()
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'sources', 'readme', 'build'])
  // Removing a tab after the hidden lines removes the right line.
  await stepMenu(page, 'readme', 'Remove tab')
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'sources', 'build'])
  const after = await alphaPage()
  expect(after).toContain('- [Git](git:)\n- [Claude setup](setup:)\n- [sources](src/)\n- [build]')
  expect(after).not.toContain('README.md')
  // The dialog no longer offers them.
  await tabs(page).getByRole('button', { name: 'Add step' }).click()
  await expect(page.getByRole('form', { name: 'Add step' }).getByRole('radio')).toHaveText(['File browser', 'Folder', 'Note', 'Report', 'File', 'Chat', 'Launcher', 'Link'])
})

test('Save as profile steps writes Workflow.md from an item’s tabs; every item keeps its own', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await stepMenu(page, 'build', 'Remove tab')
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'sources', 'readme'])
  const alphaBefore = await alphaPage()
  await stepMenu(page, 'readme', 'Save as profile steps')
  const workflow = () => fsp.readFile(wikiPage('Workflow.md'), 'utf8')
  await expect.poll(async () => (await workflow()).includes('run:make')).toBe(false)
  expect(await workflow()).toContain('- [All files](files:)\n- [sources](src/)\n- [readme](README.md)\n')
  // Every page keeps its own tabs; the profile steps are what Add profile steps brings.
  expect(await alphaPage()).toBe(alphaBefore)
  await entry(page, 'Beta').click()
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'sources', 'readme', 'build'])
})

test('Home shows recent work and today, not the nav again', async ({ page }) => {
  await expect(page.locator('.recent-list')).toHaveCount(0)
  await expect(page.locator('.home-page')).toContainText('Nothing opened yet')
  await expect(page.locator('.home-page')).not.toContainText('Echo tool')

  await entry(page, 'Alpha').click()
  await tab(page, 'sources').click()
  await entry(page, 'Ideas').click()
  await expect(page.locator('.markdown h1')).toHaveText('Ideas')
  await page.getByRole('button', { name: 'Home', exact: true }).click()

  const recent = page.locator('.recent-list .label')
  await expect(recent).toHaveText(['Ideas', 'Alpha › sources', 'Alpha'])
  await expect(page.locator('.today-card')).toContainText('Today')
  await page.screenshot({ path: 'test-results/home-recent.png' })

  await page.locator('.recent-list button', { hasText: 'Alpha › sources' }).click()
  await expect(tab(page, 'sources')).toHaveAttribute('aria-selected', 'true')
  await expect(entry(page, 'Alpha')).toHaveClass(/selected/)
})
