import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { encodePng } from '../server/thumbs.ts'
import { ALPHA, HOME, page as wikiPage, resetFixture, WORK, WORK_FILE, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const indexMd = () => fsp.readFile(WORK_FILE, 'utf8')
const wikiText = (rel: string) => fsp.readFile(wikiPage(rel), 'utf8')
const picker = (page: Page) => page.getByRole('button', { name: /^Drawer: / })
const switcher = (page: Page) => page.getByRole('dialog', { name: 'Quick switcher' })
// A 120×80 picture: the logo is its middle, scaled to 64×64.
const PICTURE = encodePng(120, 80, Buffer.from(Array.from({ length: 120 * 80 }, () => [180, 120, 60, 255]).flat()))

/** Work with two drawers: its own headings, and Research. Written as pages: drawers/Work.md and drawers/Research.md. */
const DRAWERS = `name: Work
accent: "#7d93ab"
drawers:
  - name: Work
    sections:
      - title: Projects
        items:
          - { label: Alpha, type: folder, path: ~/alpha }
          - { label: Beta, type: folder, path: ~/beta }
  - name: Research
    folder: ~/workbench/work/drawers/research
    sections:
      - title: Reading
        items:
          - { label: Ideas, type: note, path: ~/workbench/work/Ideas.md }
`

async function pickDrawer(page: Page, name: string) {
  await picker(page).click()
  await page.getByRole('menu').getByRole('menuitemradio', { name }).click()
  await expect(picker(page)).toHaveAccessibleName(`Drawer: ${name}`)
}

async function drawerMenu(page: Page, item: string) {
  await picker(page).click()
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click()
}

async function withDrawers(page: Page) {
  await fsp.mkdir(path.join(HOME, 'workbench/work/drawers/research'), { recursive: true })
  await writeWork(DRAWERS)
  await page.reload()
  await expect(entry(page, 'Beta')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('New drawer moves the nav into a first drawer page; the shown drawer is remembered; Undo restores the files', async ({ page }) => {
  await expect(picker(page)).toHaveAccessibleName('Drawer: Work')
  await drawerMenu(page, 'New drawer…')
  const dialog = page.getByRole('dialog', { name: 'New drawer' })
  await expect(dialog).toContainText('Your current headings become the first drawer, Work')
  await dialog.locator('input[name=drawerName]').fill('Research')
  await dialog.getByRole('button', { name: 'Add drawer' }).click()

  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await expect(entry(page, 'Alpha')).toHaveCount(0)
  await expect(page.getByText('No headings yet')).toBeVisible()
  expect(await indexMd()).toContain('## Drawers\n\n- [[drawers/Work]]\n- [[drawers/Research]]\n')
  expect(await wikiText('drawers/Work.md')).toContain('## Projects\n\n- [[Alpha]]\n- [[Beta]]')
  expect(await wikiText('drawers/Research.md')).toBe('# Research\n')

  await page.reload()
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await picker(page).click()
  await page.screenshot({ path: 'test-results/drawers-menu.png' })
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Work' }).click()
  await expect(entry(page, 'Alpha')).toBeVisible()

  await drawerMenu(page, 'Drawer settings…')
  await page.getByRole('dialog', { name: 'Drawer settings' }).getByRole('button', { name: 'Delete drawer…' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Its 3 headings and 7 entries leave the switcher')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect.poll(indexMd).not.toContain('drawers/Work')
  // The drawer's page stays; only the list in index.md changed.
  expect(await wikiText('drawers/Work.md')).toContain('[[Alpha]]')
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await page.locator('.toast', { hasText: 'Deleted drawer Work' }).getByRole('button', { name: 'Undo' }).click()
  await expect.poll(indexMd).toContain('[[drawers/Work]]')
})

test('Show in drawers links the same page from another drawer; deleting it in one drawer leaves the other', async ({ page }) => {
  await withDrawers(page)
  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: 'Show in Research' }).click()
  await expect.poll(() => wikiText('drawers/Research.md')).toContain('## Projects\n\n- [[Alpha]]\n')

  await pickDrawer(page, 'Research')
  const shared = entry(page, 'Alpha')
  await expect(nav(page).locator('.section', { hasText: 'Projects' })).toBeVisible()
  await shared.click()
  await expect(page.locator('.page-title')).toContainText('Alpha')
  await expect(page.locator('.item-view')).toBeVisible()
  // Opening it keeps the drawer it was opened from.
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await expect(shared).toHaveClass(/selected/)
  await page.screenshot({ path: 'test-results/drawers-shared.png' })
  // From here, the page is shown in Work too.
  await shared.click({ button: 'right' })
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show in Work' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')

  // Deleting it in Work takes only Work's link: Research keeps it, without asking.
  await pickDrawer(page, 'Work')
  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect.poll(() => wikiText('drawers/Work.md')).not.toContain('Alpha')
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  expect(await wikiText('drawers/Research.md')).toContain('- [[Alpha]]\n')
  // The page itself is never deleted with its link.
  expect(await wikiText('pages/Alpha.md')).toContain('folder: ~/alpha')

  // From Research: shown in Work again, then not; Research keeps its own.
  await pickDrawer(page, 'Research')
  await entry(page, 'Alpha').click({ button: 'right' })
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show in Work' })).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('menuitemcheckbox', { name: 'Show in Work' }).click()
  await expect.poll(() => wikiText('drawers/Work.md')).toContain('[[Alpha]]')
  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: 'Show in Work' }).click()
  await expect.poll(() => wikiText('drawers/Work.md')).not.toContain('Alpha')
  expect(await wikiText('drawers/Research.md')).toContain('- [[Alpha]]\n')
})

test('Drawer settings: a logo, the drawer’s own folder by default, the drawers used; the Shared heading opens them', async ({ page }) => {
  await withDrawers(page)
  await drawerMenu(page, 'Drawer settings…')
  const dialog = page.getByRole('dialog', { name: 'Drawer settings' })
  await dialog.getByLabel('Logo picture').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PICTURE })
  await expect(dialog.locator('.drawer-logo img')).toBeVisible()
  // The folder field is empty: the drawer works in drawers/Work inside the profile, made already.
  await expect(dialog.locator('input[name=drawerFolder]')).toHaveValue('')
  await expect(dialog.locator('input[name=drawerFolder]')).toHaveAttribute('placeholder', 'drawers/Work (its own)')
  expect((await fsp.stat(path.join(HOME, 'workbench/work/drawers/Work'))).isDirectory()).toBe(true)
  await dialog.getByRole('checkbox', { name: /Research/ }).check()
  await page.screenshot({ path: 'test-results/drawers-settings.png' })
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect.poll(() => wikiText('drawers/Work.md')).toMatch(/^---\nlogo: [0-9a-f]{12}\.png\nuses:\n  - Research\n---\n## Projects/)
  await expect(picker(page).locator('.drawer-logo img')).toBeVisible()

  // Shared lists the folders used from other drawers; the drawer's own is the rail's Files.
  const sharedHeading = nav(page).getByRole('group', { name: 'Shared' })
  await expect(sharedHeading.locator('.item')).toHaveText(['Research'])
  await sharedHeading.locator('.item', { hasText: 'Research' }).click()
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
  await expect(sharedHeading.locator('.item', { hasText: 'Research' })).toHaveClass(/selected/)
})

test('Use as drawer logo in the file browser makes the first drawer page', async ({ page }) => {
  await fsp.writeFile(path.join(ALPHA, 'badge.png'), PICTURE)
  await entry(page, 'Alpha').click()
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'badge.png' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Use as drawer logo' }).click()
  // The page does not exist until the op lands: a missing file reads as empty while polling.
  await expect.poll(() => wikiText('drawers/Work.md').catch(() => '')).toMatch(/^---\nlogo: [0-9a-f]{12}\.png\n---\n/)
  expect(await indexMd()).toContain('## Drawers\n\n- [[drawers/Work]]\n')
  await expect(picker(page).locator('.drawer-logo img')).toBeVisible()
})

test('Ctrl+K finds entries in every drawer and brings their drawer along', async ({ page }) => {
  await withDrawers(page)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('ideas')
  const option = switcher(page).getByRole('option', { name: /Ideas/ }).first()
  await expect(option).toContainText('Research › Reading')
  await option.click()
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await expect(entry(page, 'Ideas')).toHaveClass(/selected/)

  await page.keyboard.press('Control+k')
  await page.keyboard.type('switch to drawer')
  await switcher(page).getByRole('option', { name: /Switch to drawer Work/ }).click()
  await expect(picker(page)).toHaveAccessibleName('Drawer: Work')
  // Back returns to the note, and to its drawer.
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
})

test('an entry listed beside the drawers is reported, not a crash', async ({ page }) => {
  await withDrawers(page)
  await fsp.writeFile(WORK_FILE, (await indexMd()).replace('- [[drawers/Research]]\n', '- [[drawers/Research]]\n- [[Alpha]]\n'))
  await expect(page.locator('.banner.soft')).toContainText('could not be read')
  await expect(entry(page, 'Beta')).toBeVisible()
  await writeWork(WORK)
  await expect(page.locator('.banner.soft')).toHaveCount(0)
})
