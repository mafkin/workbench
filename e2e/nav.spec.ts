import fsp from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { resetFixture, SPAWN_LOG, WORK, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const accent = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))
const workYaml = () => fsp.readFile(WORK_FILE, 'utf8')

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('profile switch swaps nav, accent and title', async ({ page }) => {
  expect(await accent(page)).toBe('#7d93ab')
  await page.getByRole('tab', { name: 'Personal' }).click()
  await expect(entry(page, 'Tuohi')).toBeVisible()
  await expect(entry(page, 'Alpha')).toHaveCount(0)
  expect(await accent(page)).toBe('#8fa58a')
  await expect(page).toHaveTitle('Personal · Workbench')
  await page.screenshot({ path: 'test-results/personal.png' })

  await page.keyboard.press('Control+1')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect.poll(async () => (await fsp.readFile(WORK_FILE.replace('profiles/work.yaml', 'settings.yaml'), 'utf8'))).toContain('activeProfile: work')
})

test('selecting a folder shows its view', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await expect(page.locator('.page-title')).toHaveText('Alpha')
  await expect(page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md' })).toBeVisible()
  await expect(entry(page, 'Alpha')).toHaveClass(/selected/)
  await page.screenshot({ path: 'test-results/folder.png' })
})

test('a launcher starts its program', async ({ page }) => {
  await entry(page, 'Echo tool').click()
  await expect(page.locator('.toast')).toContainText('Started Echo tool')
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('echo hello\n')
})

test('adding a heading in the UI writes the YAML and keeps comments', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add heading' }).click()
  await page.getByPlaceholder('Heading title').fill('Docs')
  await page.keyboard.press('Enter')
  await expect(nav(page).locator('.section-head', { hasText: 'Docs' })).toBeVisible()
  const text = await workYaml()
  expect(text).toContain('title: Docs')
  expect(text).toContain('# fixture: work profile')
  expect(text).toContain('# first entry comment')
  await page.screenshot({ path: 'test-results/editing.png' })
})

test('adding an entry through the dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Tools' }).click()
  const dialog = page.getByRole('form', { name: 'Add entry' })
  await dialog.getByRole('radio', { name: 'Link' }).click()
  await dialog.locator('input[name=label]').fill('Docs site')
  await dialog.locator('input[name=url]').fill('not a url')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog.locator('.err')).toHaveText('Not a valid URL')
  await dialog.locator('input[name=url]').fill('https://example.com/docs')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(entry(page, 'Docs site')).toBeVisible()
  expect(await workYaml()).toContain('url: https://example.com/docs')
})

test('a hand edit to the YAML shows up live', async ({ page }) => {
  await fsp.writeFile(WORK_FILE, WORK.replace('label: Beta', 'label: Beta (edited by hand)'))
  await expect(entry(page, 'Beta (edited by hand)')).toBeVisible()
})

test('a broken file shows the banner, keeps the nav and recovers', async ({ page }) => {
  await fsp.writeFile(WORK_FILE, WORK.replace('name: Work', 'name: [Work'))
  const banner = page.getByRole('alert')
  await expect(banner).toContainText('work.yaml has an error')
  await expect(banner).toContainText('line')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await page.screenshot({ path: 'test-results/broken.png' })
  await fsp.writeFile(WORK_FILE, WORK)
  await expect(banner).toHaveCount(0)
})

test('delete and undo', async ({ page }) => {
  await entry(page, 'Beta').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(entry(page, 'Beta')).toHaveCount(0)
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(entry(page, 'Beta')).toBeVisible()
  expect(await workYaml()).toBe(WORK)
})

test('drag an entry to reorder it', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  const handle = page.getByLabel('Drag Alpha')
  const target = entry(page, 'Gamma')
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 })
  await page.mouse.move(to.x + 40, to.y + to.height / 2 + 4, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(async () => {
      const t = await workYaml()
      return ['Alpha', 'Beta', 'Gamma'].sort((a, b) => t.indexOf(`label: ${a}`) - t.indexOf(`label: ${b}`))
    })
    .toEqual(['Beta', 'Gamma', 'Alpha'])
  // The comment travels with its entry.
  const t = await workYaml()
  expect(t.indexOf('# first entry comment')).toBeGreaterThan(t.indexOf('label: Gamma'))
  expect(t.indexOf('# first entry comment')).toBeLessThan(t.indexOf('label: Alpha'))
})

test('drag an entry to another heading', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  const handle = page.getByLabel('Drag Beta')
  const target = entry(page, 'Echo tool')
  const from = (await handle.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 })
  await page.mouse.move(to.x + 40, to.y + 6, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => {
    const t = await workYaml()
    return t.indexOf('label: Beta') > t.indexOf('title: Tools')
  }).toBe(true)
})
