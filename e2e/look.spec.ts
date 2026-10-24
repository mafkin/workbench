import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, resetFixture, SPAWN_LOG, WB, WORK, WORK_FILE, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const workYaml = () => fsp.readFile(WORK_FILE, 'utf8')
const rootVar = (page: Page, name: string) => page.evaluate((n) => document.documentElement.style.getPropertyValue(n), name)
const panel = (page: Page) => page.getByRole('dialog', { name: 'Theme and background' })
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Theme and background' }).click()
  await expect(panel(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('a link opens from its button; its name is just text', async ({ page }) => {
  await writeWork(WORK.replace('        args: [hello]\n', '        args: [hello]\n      - { label: Docs, type: link, url: "https://example.com/docs" }\n'))
  await expect(entry(page, 'Docs')).toBeVisible()
  await entry(page, 'Docs').locator('.label').click()
  await page.waitForTimeout(300)
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('')
  await page.getByRole('button', { name: 'Open Docs' }).click()
  await expect(page.locator('.toast')).toContainText('Opened Docs')
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('xdg-open https://example.com/docs\n')
  await page.screenshot({ path: 'test-results/look-sidebar.png' })
})

test('picking a theme writes it to the YAML and recolours the app', async ({ page }) => {
  expect(await rootVar(page, '--bg')).toBe('#141518')
  await openPanel(page)
  await panel(page).getByRole('radio', { name: 'Fjord' }).click()
  await expect.poll(workYaml).toMatch(/accent: "#7d93ab"\ntheme: fjord\n/)
  await expect.poll(() => rootVar(page, '--bg')).toBe('#10151b')
  await expect(panel(page).getByRole('radio', { name: 'Fjord' })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: 'test-results/look-panel.png' })
  // Undo puts the file back.
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(workYaml).not.toContain('theme:')
})

test("the theme's own background shows behind frosted panels; None gives the flat look", async ({ page }) => {
  await expect(page.locator('.app')).toHaveClass(/backdrop/)
  expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('gradient')
  await openPanel(page)
  await panel(page).getByRole('radio', { name: 'None' }).click()
  await expect.poll(workYaml).toContain('background: none\n')
  await expect(page.locator('.app')).not.toHaveClass(/backdrop/)
  await panel(page).getByRole('radio', { name: "Theme's own" }).click()
  await expect.poll(workYaml).not.toContain('background:')
  await expect(page.locator('.app')).toHaveClass(/backdrop/)
})

test('Use as background in the file browser copies the picture and shows it', async ({ page }) => {
  await fsp.writeFile(path.join(ALPHA, 'photo.png'), PNG)
  await entry(page, 'Alpha').click()
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'photo.png' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Use as background' }).click()
  await expect.poll(workYaml).toContain('background: photo.png\n')
  await expect.poll(() => rootVar(page, '--backdrop')).toContain('url("blob:')
  // Pictures the app copies live in the Workbench folder (part 13).
  expect(fs.readFileSync(path.join(WB, 'backgrounds/photo.png'))).toEqual(PNG)
})

test('a picture added by path can be picked and deleted; then the theme’s own shows again', async ({ page }) => {
  await fsp.writeFile(path.join(ALPHA, 'photo.png'), PNG)
  await openPanel(page)
  await panel(page).getByRole('textbox', { name: 'Picture path' }).fill('~/alpha/photo.png')
  await panel(page).getByRole('button', { name: 'Add picture' }).click()
  await expect(panel(page).getByRole('radio', { name: 'photo.png' })).toHaveAttribute('aria-checked', 'true')
  await expect.poll(workYaml).toContain('background: photo.png\n')

  await panel(page).getByRole('textbox', { name: 'Picture path' }).fill('~/alpha/README.md')
  await panel(page).getByRole('button', { name: 'Add picture' }).click()
  await expect(panel(page)).toContainText('Only jpg, png, webp, avif or gif pictures')

  await panel(page).locator('.bg-picture').hover()
  await panel(page).getByRole('button', { name: 'Delete photo.png' }).click()
  await expect(panel(page).getByRole('radio', { name: 'photo.png' })).toHaveCount(0)
  await expect.poll(workYaml).not.toContain('background:')
  await expect.poll(() => rootVar(page, '--backdrop')).not.toContain('blob:')
})
