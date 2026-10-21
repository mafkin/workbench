import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, resetFixture, SPAWN_LOG, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })
const tabNames = (page: Page) => tabs(page).locator('.step-tab:not(.add)').allInnerTexts()
const row = (page: Page, name: string) => page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name, exact: true })
const workYaml = () => fsp.readFile(WORK_FILE, 'utf8')

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
  expect(await tabNames(page)).toEqual(['All files', 'sources', 'readme', 'build'])
  await expect(tab(page, 'All files')).toHaveAttribute('aria-selected', 'true')
  await expect(row(page, 'README.md')).toBeVisible()
  await page.screenshot({ path: 'test-results/project-tabs.png' })
})

test('a folder step shows its folder, and the tab is remembered', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tab(page, 'sources').click()
  await expect(row(page, 'main.py')).toHaveAttribute('aria-level', '1')
  await expect(page.locator('.crumbs')).toContainText('Alpha/sources')
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

test('adding a step copies the profile steps into the project, and a missing folder can be made', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'Add step' }).click()
  const dialog = page.getByRole('form', { name: 'Add step' })
  await expect(dialog.getByRole('radio')).toHaveCount(6)
  await dialog.locator('input[name=label]').fill('assets')
  await dialog.locator('input[name=path]').fill('art/assets')
  await expect(dialog).toContainText('Not found on disk')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await tabNames(page)).toEqual(['All files', 'sources', 'readme', 'build', 'assets'])

  const yaml = await workYaml()
  expect(yaml).toMatch(/path: ~\/alpha\n\s+steps:\n/)
  expect(yaml).toContain('- { label: assets, type: folder, path: art/assets }')
  expect(yaml).toContain('# Every project starts with these')
  expect(yaml).toContain('# first entry comment')

  await tab(page, 'assets').click()
  await page.getByRole('button', { name: 'Create folder' }).click()
  await expect(page.locator('.file-empty')).toHaveText('Empty folder')
  expect(fs.statSync(path.join(ALPHA, 'art/assets')).isDirectory()).toBe(true)
  await page.screenshot({ path: 'test-results/project-new-step.png' })
})

test('steps can be edited, reordered and removed; Reset brings back the profile steps', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await stepMenu(page, 'readme', 'Edit…')
  const dialog = page.getByRole('form', { name: 'Edit step' })
  await dialog.locator('input[name=label]').fill('intro')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(tab(page, 'intro')).toBeVisible()

  await tabs(page).getByRole('button', { name: 'build' }).dragTo(tab(page, 'sources'))
  await expect.poll(() => tabNames(page)).toEqual(['All files', 'build', 'sources', 'intro'])

  await stepMenu(page, 'intro', 'Remove')
  await expect.poll(() => tabNames(page)).toEqual(['All files', 'build', 'sources'])

  await stepMenu(page, 'sources', 'Reset to profile steps')
  await expect.poll(() => tabNames(page)).toEqual(['All files', 'sources', 'readme', 'build'])
  expect(await workYaml()).not.toContain('steps:')
})

test("one project's steps can become every project's", async ({ page }) => {
  await entry(page, 'Alpha').click()
  await stepMenu(page, 'build', 'Remove')
  await expect.poll(() => tabNames(page)).toEqual(['All files', 'sources', 'readme'])
  await stepMenu(page, 'readme', 'Use these steps for every project')
  await expect.poll(async () => (await workYaml()).includes('command: make')).toBe(false)
  expect(await workYaml()).not.toContain('steps:')
  await entry(page, 'Beta').click()
  await expect.poll(() => tabNames(page)).toEqual(['All files', 'sources', 'readme'])
})

test('Home shows recent work and today, not the nav again', async ({ page }) => {
  await expect(page.locator('.recent-list')).toHaveCount(0)
  await expect(page.locator('.home-page')).toContainText('Nothing opened yet')
  await expect(page.locator('.home-page')).not.toContainText('Echo tool')

  await entry(page, 'Alpha').click()
  await tab(page, 'sources').click()
  await entry(page, 'Ideas').click()
  await expect(page.locator('.markdown h1')).toHaveText('Ideas')
  await page.locator('.crumbs button').first().click()

  const recent = page.locator('.recent-list .label')
  await expect(recent).toHaveText(['Ideas', 'Alpha › sources', 'Alpha'])
  await expect(page.locator('.today-card')).toContainText('Today')
  await page.screenshot({ path: 'test-results/home-recent.png' })

  await page.locator('.recent-list button', { hasText: 'Alpha › sources' }).click()
  await expect(tab(page, 'sources')).toHaveAttribute('aria-selected', 'true')
  await expect(entry(page, 'Alpha')).toHaveClass(/selected/)
})
