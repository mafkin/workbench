import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DIR, HOME, profileButton, profileMenu, resetFixture, WORK, WORK_FILE, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const switcher = (page: Page) => page.getByRole('dialog', { name: 'Quick switcher' })
/** The profiles listed in the profile menu (closed again before returning). */
async function profileNames(page: Page) {
  await profileButton(page).click()
  const names = await page.getByRole('menu').getByRole('menuitemradio').locator('.menu-label').allTextContents()
  await page.keyboard.press('Escape')
  return names
}

async function quick(page: Page, query: string, pick: string | RegExp) {
  await page.keyboard.press('Control+k')
  await expect(switcher(page)).toBeVisible()
  await page.keyboard.type(query)
  await switcher(page).getByRole('option', { name: pick }).first().click()
  await expect(switcher(page)).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('Ctrl+K goes to entries, steps and notes, and runs actions', async ({ page }) => {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('alp')
  await expect(switcher(page).getByRole('option').first()).toContainText('Alpha')
  await page.screenshot({ path: 'test-results/polish-switcher.png' })
  await page.keyboard.press('Enter')
  await expect(page.locator('.page-title')).toContainText('Alpha')

  await quick(page, 'alpha readme', /Alpha › readme/)
  await expect(page.getByRole('tablist', { name: 'Workflow' }).getByRole('tab', { name: 'readme' })).toHaveAttribute('aria-selected', 'true')

  await quick(page, 'deploy plan', /Deploy plan/)
  await expect(page.locator('.crumbs')).toContainText('Deploy plan')

  await quick(page, 'theme', /Theme and background/)
  await expect(page.getByRole('dialog', { name: 'Theme and background' })).toBeVisible()
  await page.keyboard.press('Escape')

  await quick(page, 'switch pers', /Switch to Personal/)
  await expect(profileButton(page)).toHaveAttribute('title', /^Profile: Personal/)
})

test('Profile settings rename the profile and add and remove profiles', async ({ page }) => {
  await profileMenu(page, 'Profile settings…')
  const dialog = page.getByRole('dialog', { name: 'Profile settings' })
  await dialog.locator('input[name=name]').fill('Day job')
  await dialog.getByRole('radio', { name: '#b39b72' }).click()
  await dialog.locator('input[name=home]').fill('~/alpha')
  await page.screenshot({ path: 'test-results/polish-profile.png' })
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(profileButton(page)).toHaveAttribute('title', /^Profile: Day job/)
  const index = await fsp.readFile(WORK_FILE, 'utf8')
  expect(index).toContain('name: Day job')
  expect(index).toContain('accent: "#b39b72"')
  expect(index).toContain('home: ~/alpha')
  expect(index).toContain('## Projects')

  await profileMenu(page, 'Add profile…')
  const form = page.getByRole('form', { name: 'Add profile' })
  await expect(form.getByLabel('New profile name')).toBeFocused()
  await form.getByLabel('New profile name').fill('Side Projects')
  await expect(form.getByLabel('Profile id', { exact: true })).toHaveValue('side-projects')
  await expect(form.getByLabel('Wiki folder')).toHaveValue('~/notes/side-projects')
  await form.getByLabel('Wiki folder').fill('~/side-notes')
  await form.getByRole('checkbox').check()
  await form.getByRole('button', { name: 'Add profile' }).click()
  await expect(profileButton(page)).toHaveAttribute('title', /^Profile: Side Projects/)
  await expect(entry(page, 'Alpha')).toBeVisible()
  expect(await fsp.readFile(path.join(HOME, 'side-notes/index.md'), 'utf8')).toContain('name: Side Projects')

  await profileMenu(page, 'Profile settings…')
  await page.getByRole('button', { name: 'Remove Side Projects' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
  const dialog2 = page.getByRole('dialog', { name: 'Profile settings' })
  await expect(dialog2.getByRole('button', { name: 'Remove Side Projects' })).toHaveCount(0)
  await dialog2.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => profileNames(page)).toEqual(['Day job', 'Personal'])
  // The wiki stays on disk; only the switcher forgets it.
  expect(await fsp.readFile(path.join(HOME, 'side-notes/index.md'), 'utf8')).toContain('Side Projects')
  expect(await fsp.readFile(path.join(DIR, 'settings.yaml'), 'utf8')).not.toContain('side-projects')
})

test('the selection and Recent work follow an entry moved by hand', async ({ page }) => {
  await entry(page, 'Ideas').click()
  await expect(page.locator('.crumbs')).toContainText('Ideas')
  // Move Ideas to the top of Projects in the file itself.
  const moved = WORK.replace('      - label: Ideas\n        type: note\n        path: ~/notes/Ideas.md\n', '').replace('    items:\n      # first entry comment\n', '    items:\n      - { label: Ideas, type: note, path: ~/notes/Ideas.md }\n      # first entry comment\n')
  expect(moved).not.toBe(WORK)
  await writeWork(moved)
  await expect(nav(page).locator('.section', { hasText: 'Projects' }).locator('.item').first()).toContainText('Ideas')
  await expect(entry(page, 'Ideas')).toHaveClass(/selected/)
  await expect(page.locator('.crumbs')).toContainText('Projects')
  await page.reload()
  await expect(entry(page, 'Ideas')).toHaveClass(/selected/)
  await page.locator('.crumbs').getByRole('button').first().click()
  await expect(page.locator('.home-page')).toContainText('Ideas')
})
