import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, resetFixture, SPAWN_LOG, TRASH } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tree = (page: Page) => page.getByRole('tree', { name: 'Files' })
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true })
const preview = (page: Page) => page.getByRole('complementary', { name: 'Preview' })
const title = (page: Page) => page.locator('.page-title')

async function openAlpha(page: Page) {
  await entry(page, 'Alpha').click()
  await expect(row(page, 'README.md')).toBeVisible()
}

async function expand(page: Page, name: string) {
  await row(page, name).locator('.file-chevron').click()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('a folder entry opens as a tree; dotfiles are hidden and ignored files dimmed', async ({ page }) => {
  await openAlpha(page)
  await expect(title(page)).toHaveText('Alpha')
  const names = await tree(page).getByRole('treeitem').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  expect(names.slice(0, 2)).toEqual(['dist', 'src'])
  await expect(row(page, '.env')).toHaveCount(0)
  await expect(row(page, 'dist')).toHaveClass(/ignored/)
  await expect(row(page, 'build.log')).toHaveClass(/ignored/)
  await expect(row(page, 'src')).not.toHaveClass(/ignored/)
  await page.screenshot({ path: 'test-results/files-tree.png' })

  await page.keyboard.press('Control+h')
  await expect(row(page, '.env')).toBeVisible()
  await expect(row(page, '.gitignore')).toBeVisible()
  await page.keyboard.press('Control+h')
  await expect(row(page, '.env')).toHaveCount(0)
})

test('folders expand in place and the filter narrows the tree', async ({ page }) => {
  await openAlpha(page)
  await expand(page, 'src')
  await expect(row(page, 'main.py')).toHaveAttribute('aria-level', '2')
  await page.getByLabel('Filter by name').fill('util')
  await expect(tree(page).getByRole('treeitem')).toHaveCount(2)
  await expect(row(page, 'util.py')).toBeVisible()
  await page.getByLabel('Filter by name').press('Escape')
  await expect(row(page, 'README.md')).toBeVisible()
})

test('previews show Markdown, text, images, PDF and audio', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'README.md').click()
  await expect(preview(page).locator('.markdown h1')).toHaveText('Alpha')
  await expect(preview(page).getByRole('button', { name: 'Open as note' })).toBeVisible()
  await page.screenshot({ path: 'test-results/files-preview.png' })

  await expand(page, 'src')
  await row(page, 'main.py').click()
  await expect(preview(page).locator('pre')).toContainText('hello from alpha')

  await row(page, 'diagram.svg').click()
  const img = preview(page).locator('img')
  await expect(img).toHaveAttribute('src', /^\/raw\//)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160)

  await row(page, 'spec.pdf').click()
  await expect(preview(page).locator('iframe')).toHaveAttribute('src', /^\/raw\/.+\/spec\.pdf$/)

  await row(page, 'chime.wav').click()
  const audio = preview(page).locator('audio')
  await expect(audio).toHaveAttribute('src', /^\/raw\//)
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState)).toBeGreaterThan(0)
})

test('Markdown opens as a note and saves; Back returns to the folder', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'README.md').click()
  await preview(page).getByRole('button', { name: 'Open as note' }).click()
  await expect(title(page)).toHaveText('README')
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Edited from the browser.')
  await expect.poll(() => fsp.readFile(path.join(ALPHA, 'README.md'), 'utf8')).toContain('Edited from the browser.')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(title(page)).toHaveText('Alpha')
})

test('F2 renames in place, and Undo puts the name back', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'README.md').click()
  await page.keyboard.press('F2')
  const input = tree(page).getByLabel('New name')
  await expect(input).toBeFocused()
  await page.keyboard.type('INTRO')
  await page.keyboard.press('Enter')
  await expect(row(page, 'INTRO.md')).toBeVisible()
  expect(fs.existsSync(path.join(ALPHA, 'INTRO.md'))).toBe(true)
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(row(page, 'README.md')).toBeVisible()
  expect(fs.existsSync(path.join(ALPHA, 'INTRO.md'))).toBe(false)
})

test('New folder creates one and starts renaming it', async ({ page }) => {
  await openAlpha(page)
  await page.getByRole('button', { name: 'New folder' }).click()
  const input = tree(page).getByLabel('New name')
  await expect(input).toHaveValue('New folder')
  await input.fill('assets')
  await input.press('Enter')
  await expect(row(page, 'assets')).toBeVisible()
  expect(fs.statSync(path.join(ALPHA, 'assets')).isDirectory()).toBe(true)
})

test('Delete moves the selection to the Trash, never deleting it', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'build.log').click()
  await page.keyboard.press('Delete')
  await expect(row(page, 'build.log')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Moved build.log to Trash')
  expect(fs.existsSync(path.join(TRASH, 'build.log'))).toBe(true)
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toContain(`gio trash -- ${path.join(fs.realpathSync(ALPHA), 'build.log')}`)
})

test('dragging a file onto a folder moves it there', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'README.md').dragTo(row(page, 'src'))
  await expect(page.locator('.toast').first()).toContainText('Moved README.md to src')
  expect(fs.existsSync(path.join(ALPHA, 'src/README.md'))).toBe(true)
  await expect(row(page, 'README.md')).toHaveCount(0)
})

test('a file added on disk shows up', async ({ page }) => {
  await openAlpha(page)
  await fsp.writeFile(path.join(ALPHA, 'added-by-hand.txt'), 'hi\n')
  await expect(row(page, 'added-by-hand.txt')).toBeVisible()
})

test('the path bar and double-click move within the project', async ({ page }) => {
  await openAlpha(page)
  await row(page, 'src').dblclick()
  await expect(row(page, 'main.py')).toHaveAttribute('aria-level', '1')
  await expect(title(page)).toHaveText('Alpha')
  const bar = page.getByRole('navigation', { name: 'Path' })
  await expect(bar.locator('.unreachable')).toHaveText('~')
  await bar.getByRole('button', { name: 'alpha' }).click()
  await expect(row(page, 'README.md')).toBeVisible()
})

test('a missing folder says so', async ({ page }) => {
  await entry(page, 'Beta').click()
  await expect(tree(page)).toContainText('Not found')
})
