import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { isoDate } from '../shared/config-schema.ts'
import { HOME, NOTES, PERSONAL_FILE, resetFixture, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const title = (page: Page) => page.locator('.page-title')
const markdown = (page: Page) => page.locator('.markdown')
const IDEAS_FILE = path.join(NOTES, 'Ideas.md')
const read = (file: string) => fsp.readFile(file, 'utf8').catch(() => '')

async function editAtEnd(page: Page, text: string) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Ideas')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('a note entry opens formatted', async ({ page }) => {
  await entry(page, 'Ideas').click()
  const md = markdown(page)
  await expect(md.locator('h1')).toHaveText('Ideas')
  await expect(md.locator('strong')).toHaveText('notes')
  await expect(md.locator('td').first()).toHaveText('1')
  await expect(md.locator('input[type=checkbox]')).toHaveCount(2)
  await expect(md.locator('a.wikilink', { hasText: 'Deploy plan' })).not.toHaveClass(/missing/)
  await expect(md.locator('a.wikilink', { hasText: 'Missing page' })).toHaveClass(/missing/)
  await expect(md.locator('img')).toHaveAttribute('src', /^blob:/)
  await expect(md.locator('a', { hasText: 'link' })).toHaveAttribute('target', '_blank')
  await page.screenshot({ path: 'test-results/notes-view.png' })
})

test('editing autosaves to the file', async ({ page }) => {
  await entry(page, 'Ideas').click()
  await editAtEnd(page, '\nWritten in Workbench.')
  await expect.poll(() => read(IDEAS_FILE)).toContain('Written in Workbench.')
  await expect(page.locator('.save-status')).toHaveText('Saved')
  await page.screenshot({ path: 'test-results/notes-edit.png' })
  await page.keyboard.press('Control+e')
  await expect(markdown(page)).toContainText('Written in Workbench.')
  expect(await read(IDEAS_FILE)).toMatch(/^# Ideas\n/)
})

test('a hand edit to an open note shows up live', async ({ page }) => {
  await entry(page, 'Ideas').click()
  await expect(markdown(page).locator('h1')).toHaveText('Ideas')
  await fsp.writeFile(IDEAS_FILE, '# Ideas, edited by hand\n')
  await expect(markdown(page).locator('h1')).toHaveText('Ideas, edited by hand')
})

test('a change on disk while editing pauses autosave; Keep mine overwrites', async ({ page }) => {
  await entry(page, 'Ideas').click()
  await editAtEnd(page, 'mine')
  await fsp.writeFile(IDEAS_FILE, 'theirs\n')
  const banner = page.locator('.note-conflict')
  await expect(banner).toContainText('Changed on disk')
  await expect(page.locator('.save-status')).toHaveText('Conflict')
  // Autosave would have run by now.
  await page.waitForTimeout(1500)
  expect(await read(IDEAS_FILE)).toBe('theirs\n')
  await page.screenshot({ path: 'test-results/notes-conflict.png' })
  await banner.getByRole('button', { name: 'Keep mine' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => read(IDEAS_FILE)).toContain('mine')
  expect(await read(IDEAS_FILE)).toMatch(/^# Ideas\n/)
})

test('Reload from disk drops the unsaved text', async ({ page }) => {
  await entry(page, 'Ideas').click()
  await editAtEnd(page, 'mine')
  await fsp.writeFile(IDEAS_FILE, 'theirs\n')
  const banner = page.locator('.note-conflict')
  await banner.getByRole('button', { name: 'Reload from disk' }).click()
  await expect(banner).toHaveCount(0)
  await expect(page.locator('.cm-content')).toHaveText('theirs')
  await page.waitForTimeout(1200)
  expect(await read(IDEAS_FILE)).toBe('theirs\n')
})

test('New note under a heading creates the file and its entry', async ({ page }) => {
  await nav(page).locator('.section-head', { hasText: 'Notes' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New note…' }).click()
  const dialog = page.getByRole('form', { name: 'New note' })
  await dialog.locator('input[name=title]').fill('Deploy checklist')
  await expect(dialog).toContainText('~/notes/Deploy checklist.md')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(entry(page, 'Deploy checklist')).toHaveClass(/selected/)
  await expect(page.locator('.cm-content')).toBeFocused()
  expect(await read(path.join(NOTES, 'Deploy checklist.md'))).toBe('# Deploy checklist\n\n')
  const yaml = await read(WORK_FILE)
  expect(yaml).toContain('path: ~/notes/Deploy checklist.md')
  expect(yaml).toContain('# first entry comment')

  // The same title again would overwrite: refused.
  await nav(page).locator('.section-head', { hasText: 'Notes' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New note…' }).click()
  await dialog.locator('input[name=title]').fill('Deploy checklist')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.locator('.err')).toContainText('already exists')
})

test('a note entry whose file is missing offers to create it', async ({ page }) => {
  await entry(page, 'Gamma').click()
  await expect(page.locator('.placeholder')).toContainText('This file does not exist yet')
  await page.getByRole('button', { name: 'Create it' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()
  expect(await read(path.join(HOME, 'gamma.md'))).toBe('# Gamma\n\n')
})

test('wiki links open notes, Back returns, and a missing one can be created', async ({ page }) => {
  await entry(page, 'Runbook').click()
  await markdown(page).locator('a.wikilink', { hasText: 'Ideas' }).click()
  await expect(entry(page, 'Ideas')).toHaveClass(/selected/)

  await markdown(page).locator('a.wikilink', { hasText: 'Deploy plan' }).click()
  await expect(title(page)).toHaveText('Deploy plan')
  await expect(markdown(page)).toContainText('rollback')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(title(page)).toHaveText('Ideas')

  await markdown(page).locator('a.wikilink', { hasText: 'Missing page' }).click()
  await page.locator('.toast').getByRole('button', { name: 'Create' }).click()
  await expect(title(page)).toHaveText('Missing page')
  await expect(page.locator('.cm-content')).toBeVisible()
  expect(await read(path.join(NOTES, 'Missing page.md'))).toBe('# Missing page\n\n')
})

test('search finds notes by their text', async ({ page }) => {
  await page.keyboard.press('Control+Shift+F')
  await expect(page.getByLabel('Search notes')).toBeFocused()
  await expect(title(page)).toHaveText('Recent notes')
  // Ideas, Deploy plan, the daily template, the Runbook entry, and Alpha's README (a note step).
  await expect(page.locator('.search-results li')).toHaveCount(5)
  await page.keyboard.type('rollback')
  const hits = page.locator('.search-results li')
  await expect(hits).toHaveCount(1)
  await expect(hits).toContainText('Deploy plan')
  await expect(hits.locator('mark')).toHaveText('rollback')
  await page.screenshot({ path: 'test-results/notes-search.png' })
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('Deploy plan')
})

test('Today creates the daily note from the template', async ({ page }) => {
  const today = isoDate(new Date())
  const file = path.join(NOTES, 'daily', `${today}.md`)
  await entry(page, 'Today').click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect.poll(() => read(file)).toBe(`# ${today}\n\n## Plan\n\n- [ ] \n`)
  await page.screenshot({ path: 'test-results/notes-daily.png' })

  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('.placeholder')).toContainText('No note for')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(markdown(page).locator('h1')).toHaveText(today)
})

test('a profile without a notes folder offers one', async ({ page }) => {
  await page.getByRole('tab', { name: 'Personal' }).click()
  const hint = page.locator('.notes-hint')
  await expect(hint).toContainText('personal.yaml')
  await hint.getByRole('button', { name: 'Use ~/notes' }).click()
  await expect(hint).toHaveCount(0)
  const yaml = await read(PERSONAL_FILE)
  expect(yaml).toMatch(/accent: "#8fa58a"\nnotes: ~\/notes\nsections:/)
})
