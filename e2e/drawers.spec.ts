import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { encodePng } from '../server/thumbs.ts'
import { ALPHA, HOME, resetFixture, WORK, WORK_FILE } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const workYaml = () => fsp.readFile(WORK_FILE, 'utf8')
const picker = (page: Page) => page.getByRole('button', { name: /^Drawer: / })
const switcher = (page: Page) => page.getByRole('dialog', { name: 'Quick switcher' })
// A 120×80 picture: the logo is its middle, scaled to 64×64.
const PICTURE = encodePng(120, 80, Buffer.from(Array.from({ length: 120 * 80 }, () => [180, 120, 60, 255]).flat()))

/** Work with two drawers: its own headings, and Research. */
const DRAWERS = `name: Work
accent: "#7d93ab"
notes: ~/notes
drawers:
  - name: Work
    sections:
      - title: Projects
        items:
          - { label: Alpha, type: folder, path: ~/alpha }
          - { label: Beta, type: folder, path: ~/beta }
  - name: Research
    folder: ~/notes/drawers/research
    sections:
      - title: Reading
        items:
          - { label: Ideas, type: note, path: ~/notes/Ideas.md }
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
  await fsp.mkdir(path.join(HOME, 'notes/drawers/research'), { recursive: true })
  await fsp.writeFile(WORK_FILE, DRAWERS)
  await page.reload()
  await expect(entry(page, 'Beta')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('New drawer moves the headings into a first drawer; the shown drawer is remembered; Undo restores the file', async ({ page }) => {
  await expect(picker(page)).toHaveAccessibleName('Drawer: Work')
  await drawerMenu(page, 'New drawer…')
  const dialog = page.getByRole('dialog', { name: 'New drawer' })
  await expect(dialog).toContainText('Your current headings become the first drawer, Work')
  await dialog.locator('input[name=drawerName]').fill('Research')
  await dialog.getByRole('button', { name: 'Add drawer' }).click()

  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await expect(entry(page, 'Alpha')).toHaveCount(0)
  await expect(page.getByText('No headings yet')).toBeVisible()
  const yaml = await workYaml()
  expect(yaml).toContain('drawers:\n  - name: Work\n    sections:\n      - title: Projects\n        items:\n          # first entry comment\n')
  expect(yaml).toContain('  - name: Research\n    sections: []\n')

  await page.reload()
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await picker(page).click()
  await page.screenshot({ path: 'test-results/drawers-menu.png' })
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Work' }).click()
  await expect(entry(page, 'Alpha')).toBeVisible()

  await drawerMenu(page, 'Drawer settings…')
  await page.getByRole('dialog', { name: 'Drawer settings' }).getByRole('button', { name: 'Delete drawer…' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Its 3 headings and 7 entries go')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect.poll(workYaml).not.toContain('label: Alpha')
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await page.locator('.toast', { hasText: 'Deleted drawer Work' }).getByRole('button', { name: 'Undo' }).click()
  await expect.poll(workYaml).toContain('label: Alpha')
})

test('Show in drawers puts the same project in another drawer; deleting the original asks and removes it there too', async ({ page }) => {
  await withDrawers(page)
  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: 'Show in Research' }).click()
  await expect.poll(workYaml).toContain('- label: Alpha\n            type: shared\n            drawer: Work\n            path: ~/alpha\n')

  await pickDrawer(page, 'Research')
  const shared = entry(page, 'Alpha')
  await expect(shared).toContainText('⇄ Work')
  await expect(nav(page).locator('.section', { hasText: 'Projects' })).toBeVisible()
  await shared.click()
  await expect(page.locator('.page-title')).toContainText('Alpha')
  await expect(page.locator('.crumbs')).toContainText('Work')
  await expect(page.getByRole('tablist', { name: 'Workflow' })).toBeVisible()
  // Opening it keeps the drawer it was opened from.
  await expect(picker(page)).toHaveAccessibleName('Drawer: Research')
  await expect(shared).toHaveClass(/selected/)
  await page.screenshot({ path: 'test-results/drawers-shared.png' })

  await shared.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Go to Work' }).click()
  await expect(picker(page)).toHaveAccessibleName('Drawer: Work')
  await entry(page, 'Alpha').click({ button: 'right' })
  await expect(page.getByRole('menuitemcheckbox', { name: 'Show in Research' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('also shown in Research')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await expect.poll(workYaml).not.toContain('Alpha')
})

test('Drawer settings: a logo, the shared folder and the drawers used; the Shared heading opens them', async ({ page }) => {
  await withDrawers(page)
  await drawerMenu(page, 'Drawer settings…')
  const dialog = page.getByRole('dialog', { name: 'Drawer settings' })
  await dialog.getByLabel('Logo picture').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PICTURE })
  await expect(dialog.locator('.drawer-logo img')).toBeVisible()
  await dialog.getByRole('button', { name: 'Use ~/notes/drawers/work' }).click()
  await expect(dialog.locator('input[name=drawerFolder]')).toHaveValue('~/notes/drawers/work')
  await dialog.getByRole('checkbox', { name: /Research/ }).check()
  await page.screenshot({ path: 'test-results/drawers-settings.png' })
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect.poll(workYaml).toMatch(/  - name: Work\n    logo: [0-9a-f]{12}\.png\n    folder: ~\/notes\/drawers\/work\n    uses: \[ Research \]\n    sections:/)
  expect((await fsp.stat(path.join(HOME, 'notes/drawers/work'))).isDirectory()).toBe(true)
  await expect(picker(page).locator('.drawer-logo img')).toBeVisible()

  const sharedHeading = nav(page).getByRole('group', { name: 'Shared' })
  await expect(sharedHeading.locator('.item')).toHaveText(['Workthis drawer', 'Research'])
  await sharedHeading.locator('.item', { hasText: 'Research' }).click()
  await expect(page.locator('.crumbs')).toContainText('research')
  await expect(page.getByRole('tree', { name: 'Files' })).toBeVisible()
  await expect(sharedHeading.locator('.item', { hasText: 'Research' })).toHaveClass(/selected/)
})

test('Use as drawer logo in the file browser', async ({ page }) => {
  await fsp.writeFile(path.join(ALPHA, 'badge.png'), PICTURE)
  await entry(page, 'Alpha').click()
  await page.getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'badge.png' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Use as drawer logo' }).click()
  await expect.poll(workYaml).toMatch(/drawers:\n {2}- name: Work\n {4}logo: [0-9a-f]{12}\.png\n/)
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

test('a file with drawers and sections both is an error banner, not a crash', async ({ page }) => {
  await fsp.writeFile(WORK_FILE, DRAWERS + 'sections:\n  - title: Stray\n    items: []\n')
  await expect(page.getByRole('alert')).toContainText('either sections: or drawers:')
  await fsp.writeFile(WORK_FILE, WORK)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
