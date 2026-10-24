import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { NOTES, page as wikiPage, resetFixture, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const tabNames = async (page: Page) => (await tabs(page).locator('.step-tab:not(.add)').allInnerTexts()).map((t) => t.split('\n')[0].trim())
const indexMd = () => fsp.readFile(WORK_FILE, 'utf8')
const wikiText = (rel: string) => fsp.readFile(wikiPage(rel), 'utf8')

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

async function addItem(page: Page, label: string) {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Tools' }).click()
  const dialog = page.getByRole('form', { name: 'Add item' })
  await dialog.locator('input[name=label]').fill(label)
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await entry(page, label).click()
}

test('a new item is a page in pages/; its first step fills the page, the second brings the tab row', async ({ page }) => {
  await addItem(page, 'Board')
  // Without tabs, the page itself shows, with the ways to add one.
  await expect(page.locator('.item-page .markdown h1')).toHaveText('Board')
  await expect(tabs(page)).toHaveCount(0)
  expect(await indexMd()).toContain('- [[Board]]\n')
  expect(await wikiText('pages/Board.md')).toBe('# Board\n')
  await page.screenshot({ path: 'test-results/item-blank.png' })

  // A note: no folder needed, and it fills the page.
  await page.locator('.item-page').getByRole('button', { name: 'Note' }).click()
  const note = page.getByRole('form', { name: 'Add step' })
  await expect(note.getByRole('radio', { name: 'Note' })).toHaveAttribute('aria-checked', 'true')
  await note.locator('input[name=label]').fill('ideas')
  await note.locator('input[name=path]').fill('~/workbench/work/Ideas.md')
  await note.getByRole('button', { name: 'Add' }).click()
  await expect(page.locator('.markdown h1')).toHaveText('Ideas')
  await expect(tabs(page)).toHaveCount(0)
  await page.screenshot({ path: 'test-results/item-one-step.png' })

  // The file browser shows the item's folder: the item has none, so the dialog asks for it.
  await page.locator('.item-head').getByRole('button', { name: 'Add step' }).click()
  const files = page.getByRole('form', { name: 'Add step' })
  await files.getByRole('radio', { name: 'File browser' }).click()
  await expect(files.locator('input[name=label]')).toHaveValue('All files')
  await files.getByRole('button', { name: 'Add' }).click()
  await expect(files.locator('.err')).toHaveText('Choose the folder this item is about')
  await files.locator('input[name=itemFolder]').fill('~/alpha')
  await files.getByRole('button', { name: 'Add' }).click()
  await expect(files).toHaveCount(0)
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'ideas', 'All files'])
  expect(await wikiText('pages/Board.md')).toBe('---\nfolder: ~/alpha\n---\n# Board\n\n## Workflow\n\n- [ideas](~/workbench/work/Ideas.md)\n- [All files](files:)\n')
  await tabs(page).getByRole('tab', { name: 'All files' }).click()
  await expect(page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md' })).toBeVisible()
  await page.screenshot({ path: 'test-results/item-two-steps.png' })
})

test('removing a step removes only the tab: the file stays, Undo brings it back, and the last one leaves the item blank', async ({ page }) => {
  await addItem(page, 'Board')
  await page.locator('.item-page').getByRole('button', { name: 'Note' }).click()
  const dialog = page.getByRole('form', { name: 'Add step' })
  await dialog.locator('input[name=label]').fill('ideas')
  await dialog.locator('input[name=path]').fill('~/workbench/work/Ideas.md')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('button', { name: 'New chat' }).waitFor()

  await page.locator('.item-head').getByRole('button', { name: 'Add step' }).click()
  const link = page.getByRole('form', { name: 'Add step' })
  await link.getByRole('radio', { name: 'Link' }).click()
  await link.locator('input[name=label]').fill('board')
  await link.locator('input[name=url]').fill('https://example.com/board')
  await link.getByRole('button', { name: 'Add' }).click()
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'ideas', 'board'])

  await tabs(page).locator('.step-tab', { hasText: 'ideas' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Remove tab/ }).click()
  await expect(page.locator('.toast')).toContainText('its files stay')
  expect(fs.existsSync(path.join(NOTES, 'Ideas.md'))).toBe(true)
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'ideas', 'board'])

  for (const name of ['ideas', 'board']) {
    await tabs(page).locator('.step-tab', { hasText: name }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Remove tab/ }).click()
    await expect(tabs(page).locator('.step-tab', { hasText: name })).toHaveCount(0)
  }
  await expect(page.locator('.item-page .markdown h1')).toHaveText('Board')
  expect(fs.existsSync(path.join(NOTES, 'Ideas.md'))).toBe(true)
})

test('an item with a folder adds the file browser in one click; a folder step needs no folder prompt', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Tools' }).click()
  const dialog = page.getByRole('form', { name: 'Add item' })
  await dialog.locator('input[name=label]').fill('Alpha again')
  await dialog.locator('input[name=path]').fill('~/alpha')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await entry(page, 'Alpha again').click()
  expect(await wikiText('pages/Alpha again.md')).toBe('---\nfolder: ~/alpha\n---\n# Alpha again\n')

  await page.locator('.item-page').getByRole('button', { name: 'File browser' }).click()
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
  await page.locator('.item-head').getByRole('button', { name: 'Add step' }).click()
  const step = page.getByRole('form', { name: 'Add step' })
  await step.getByRole('radio', { name: 'Folder' }).click()
  await expect(step.locator('input[name=itemFolder]')).toHaveCount(0)
  await step.locator('input[name=label]').fill('sources')
  await step.locator('input[name=path]').fill('src')
  await step.getByRole('button', { name: 'Add' }).click()
  await expect.poll(() => tabNames(page)).toEqual(['Page', 'All files', 'sources'])
})
