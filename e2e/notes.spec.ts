import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { isoDate } from '../shared/config-schema.ts'
import { HOME, NOTES, pickProfile, resetFixture, WORK_FILE } from './fixture.ts'

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
  // An image's title is its caption.
  await expect(md.locator('.img-caption')).toHaveText('The parts, roughly')
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
  await expect(dialog).toContainText('~/workbench/work/Deploy checklist.md')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(entry(page, 'Deploy checklist')).toHaveClass(/selected/)
  await expect(page.locator('.cm-content')).toBeFocused()
  expect(await read(path.join(NOTES, 'Deploy checklist.md'))).toBe('# Deploy checklist\n\n')
  expect(await read(WORK_FILE)).toContain('- [Deploy checklist](Deploy%20checklist.md)\n')

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
  await page.getByRole('button', { name: 'Back', exact: true }).click()
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
  // Ideas, Deploy plan, the daily template, the Runbook entry, Alpha's README (a note step), and the wiki's own
  // pages: index.md, Workflow.md, pages/Alpha.md and pages/Beta.md.
  await expect(page.locator('.search-results li')).toHaveCount(9)
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

test('every profile’s notes live in its wiki; Personal has its own', async ({ page }) => {
  await pickProfile(page, 'Personal')
  await nav(page).locator('.section-head', { hasText: 'Games' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New note…' }).click()
  const dialog = page.getByRole('form', { name: 'New note' })
  await dialog.locator('input[name=title]').fill('Loot tables')
  await expect(dialog).toContainText('~/workbench/personal/Loot tables.md')
  await page.keyboard.press('Escape')
})

test('properties show from frontmatter, Mentions list the notes linking here, and Rename rewrites their links', async ({ page }) => {
  await fsp.writeFile(path.join(NOTES, 'Tuohi.md'), '---\nstatus: paused\ntags: [game, art]\n---\n# Tuohi\n\nSee [[Deploy plan]].\n')
  await page.reload()
  await entry(page, 'Ideas').click()
  await markdown(page).locator('a.wikilink', { hasText: 'Deploy plan' }).click()
  await expect(title(page)).toHaveText('Deploy plan')
  const mentions = page.getByRole('region', { name: 'Mentions' })
  await expect(mentions).toContainText('Ideas')
  await expect(mentions).toContainText('Tuohi')

  await page.getByRole('button', { name: 'Rename' }).click()
  await page.getByLabel('Note name').fill('Release plan')
  await page.keyboard.press('Enter')
  await expect(title(page)).toHaveText('Release plan')
  await expect(page.locator('.toast')).toContainText('Renamed')
  expect(await read(IDEAS_FILE)).toContain('[[Release plan]]')
  expect(await read(path.join(NOTES, 'Tuohi.md'))).toContain('[[Release plan]]')
  expect(await read(path.join(NOTES, 'work/Release plan.md'))).toContain('# Deploy plan')

  await mentions.getByRole('button', { name: /Tuohi/ }).click()
  await expect(title(page)).toHaveText('Tuohi')
  const props = page.getByLabel('Properties')
  await expect(props).toContainText('status')
  await expect(props).toContainText('paused')
  await expect(props.getByRole('button', { name: '#game' })).toBeVisible()
  await expect(props).toContainText('#art')
  await expect(markdown(page)).not.toContainText('status: paused')
  await expect(markdown(page)).toContainText('See')
})

test('before a query the search shows the tags and the pages to write; a tag chip searches, a missing page is created', async ({ page }) => {
  await fsp.writeFile(path.join(NOTES, 'Tuohi.md'), '---\ntags: [game]\n---\n# Tuohi\n\nA #game about birch bark; see [[Art direction]].\n')
  await page.reload()
  await expect(entry(page, 'Alpha')).toBeVisible()
  await page.keyboard.press('Control+Shift+F')
  await expect(title(page)).toHaveText('Recent notes')
  const tags = page.getByRole('region', { name: 'Tags' })
  await expect(tags.getByRole('button', { name: /game/ })).toContainText('1')
  const missing = page.getByRole('region', { name: 'Pages to write' })
  // Ideas links [[Missing page]]; Tuohi links [[Art direction]].
  await expect(missing).toContainText('Missing page')
  await expect(missing).toContainText('Art direction')
  await page.screenshot({ path: 'test-results/notes-overview.png' })

  await tags.getByRole('button', { name: /game/ }).click()
  await expect(page.getByLabel('Search notes')).toHaveValue('#game')
  await expect(title(page)).toHaveText('“#game”')
  await expect(page.locator('.search-results li')).toHaveCount(1)
  await expect(page.locator('.search-results li')).toContainText('Tuohi')

  await page.getByLabel('Search notes').fill('')
  await missing.getByRole('button', { name: /Art direction/ }).click()
  await expect(title(page)).toHaveText('Art direction')
  expect(await read(path.join(NOTES, 'Art direction.md'))).toContain('# Art direction')
  // Written now, so it is no longer a page to write.
  await entry(page, 'Ideas').click()
  await page.keyboard.press('Control+Shift+F')
  // The overview is fetched anew: wait for it before saying what it lacks.
  await expect(missing).toContainText('Missing page')
  await expect(missing).not.toContainText('Art direction')
})
