import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { page as wikiPage, pickProfile, profileButton, resetFixture, SPAWN_LOG, WB, WORK, WORK_FILE, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const accent = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))
const indexMd = () => fsp.readFile(WORK_FILE, 'utf8')
/** The active profile as the service saved it. */
const active = async () => /^activeProfile: (\S+)$/m.exec(await fsp.readFile(path.join(WB, 'settings.yaml'), 'utf8'))?.[1]

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('profile switch swaps nav, accent and title', async ({ page }) => {
  expect(await accent(page)).toBe('#7d93ab')
  await profileButton(page).click()
  await expect(page.getByRole('menuitemradio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: 'test-results/profile-menu.png' })
  await page.keyboard.press('Escape')
  await pickProfile(page, 'Personal')
  await expect(entry(page, 'Tuohi')).toBeVisible()
  await expect(entry(page, 'Alpha')).toHaveCount(0)
  expect(await accent(page)).toBe('#8fa58a')
  await expect(page).toHaveTitle('Personal · Workbench')
  await expect.poll(active).toBe('personal')
  await page.screenshot({ path: 'test-results/personal.png' })

  await page.keyboard.press('Control+1')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect.poll(active).toBe('work')
})

test('selecting a folder shows its view', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await expect(page.locator('.page-title')).toHaveText('Alpha')
  await expect(page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md' })).toBeVisible()
  await expect(entry(page, 'Alpha')).toHaveClass(/selected/)
  await page.screenshot({ path: 'test-results/folder.png' })
})

test('a launcher starts from its button; its name is just text', async ({ page }) => {
  await entry(page, 'Echo tool').locator('.label').click()
  await page.waitForTimeout(300)
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('')
  await page.getByRole('button', { name: 'Start Echo tool' }).click()
  await expect(page.locator('.toast')).toContainText('Started Echo tool')
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('echo hello\n')
})

test('adding a heading in the UI writes index.md and keeps its prose', async ({ page }) => {
  // A line of prose above the lists, as a wiki page may have.
  await fsp.writeFile(WORK_FILE, (await indexMd()).replace('## Projects', 'Words about work.\n\n## Projects'))
  await page.reload()
  await expect(entry(page, 'Alpha')).toBeVisible()
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add heading' }).click()
  await page.getByPlaceholder('Heading title').fill('Docs')
  await page.keyboard.press('Enter')
  await expect(nav(page).locator('.section-head', { hasText: 'Docs' })).toBeVisible()
  const text = await indexMd()
  expect(text).toContain('\n## Docs\n')
  expect(text).toContain('Words about work.\n\n## Projects')
  expect(text).toContain('- [[Alpha]]')
  await page.screenshot({ path: 'test-results/editing.png' })
})

test('adding an entry through the dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Tools' }).click()
  const dialog = page.getByRole('form', { name: 'Add item' })
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog.locator('.err')).toHaveText('Label is required')
  await dialog.locator('input[name=label]').fill('Docs site')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(entry(page, 'Docs site')).toBeVisible()
  expect(await indexMd()).toContain('- [[Docs site]]\n')
  expect(await fsp.readFile(wikiPage('pages/Docs site.md'), 'utf8')).toBe('# Docs site\n')
})

test('a hand edit to index.md shows up live', async ({ page }) => {
  await fsp.writeFile(WORK_FILE, (await indexMd()).replace('[[Beta]]', '[[Beta|Beta (edited by hand)]]'))
  await expect(entry(page, 'Beta (edited by hand)')).toBeVisible()
})

test('a broken page shows the banner, keeps the nav and recovers', async ({ page }) => {
  await fsp.writeFile(WORK_FILE, '---\nname: [Work\n---\n## Nothing\n')
  const banner = page.getByRole('alert')
  await expect(banner).toContainText('has an error')
  await expect(banner).toContainText('index.md')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await page.screenshot({ path: 'test-results/broken.png' })
  await writeWork(WORK)
  await expect(banner).toHaveCount(0)
})

test('delete and undo', async ({ page }) => {
  const before = await indexMd()
  await entry(page, 'Beta').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(entry(page, 'Beta')).toHaveCount(0)
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(entry(page, 'Beta')).toBeVisible()
  expect(await indexMd()).toBe(before)
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
      const t = await indexMd()
      const at = (name: string) => t.indexOf(name === 'Gamma' ? '[Gamma](' : `[[${name}]]`)
      return ['Alpha', 'Beta', 'Gamma'].sort((a, b) => at(a) - at(b))
    })
    .toEqual(['Beta', 'Gamma', 'Alpha'])
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
    const t = await indexMd()
    return t.indexOf('[[Beta]]') > t.indexOf('## Tools')
  }).toBe(true)
})
