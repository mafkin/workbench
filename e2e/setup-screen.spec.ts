import fsp from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { DIR, HOME, SETUP_PORT } from './fixture.ts'

// The second e2e service runs without a Workbench folder (E2E_SETUP=1 in serve.ts).
const URL = `http://127.0.0.1:${SETUP_PORT}/`
const FRESH = path.join(HOME, 'Fresh bench')

test('the setup screen makes the folder with a first profile and one drawer, remembers it, and the app opens', async ({ page }) => {
  await fsp.rm(FRESH, { recursive: true, force: true })
  await page.goto(URL)
  const form = page.getByRole('form', { name: 'Set up Workbench' })
  await expect(form.getByLabel('Folder')).toHaveValue('~/Workbench')
  await expect(form.getByLabel('First profile')).toHaveValue('Main')
  await page.screenshot({ path: 'test-results/setup-screen.png' })

  await form.getByLabel('Folder').fill(FRESH)
  await form.getByLabel('First profile').fill('Studio')
  await expect(form).toContainText('studio/')
  await form.getByRole('button', { name: 'Create workbench' }).click()

  // The app, on the new folder: one profile, one drawer, nothing pointing anywhere.
  const nav = page.getByRole('navigation', { name: 'Navigation' })
  await expect(nav.getByRole('button', { name: 'Drawer: Studio' })).toBeVisible()
  await expect(nav.getByRole('group', { name: 'Studio' })).toBeVisible()
  // No entries (the Context block's own button is an .item too).
  await expect(nav.locator('.item:not(.context-setup)')).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Drawer tools' }).getByRole('button')).toHaveText(['Files', 'Git', 'Skills', 'MCP', 'Settings'])
  await page.screenshot({ path: 'test-results/setup-done.png' })

  expect(await fsp.readFile(path.join(FRESH, 'settings.yaml'), 'utf8')).toContain('profiles:\n  - studio\n')
  expect(await fsp.readFile(path.join(FRESH, 'studio/index.md'), 'utf8')).toContain('## Drawers\n\n- [[drawers/Studio]]\n')
  expect((await fsp.stat(path.join(FRESH, 'studio/drawers/Studio'))).isDirectory()).toBe(true)
  expect((await fsp.readFile(path.join(DIR, 'setup-pointer'), 'utf8')).trim()).toBe(FRESH)

  // A page added in the drawer lands in its folder.
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Studio' }).click()
  const dialog = page.getByRole('form', { name: 'Add item' })
  await dialog.locator('input[name=label]').fill('Intro')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect.poll(() => fsp.readFile(path.join(FRESH, 'studio/drawers/Studio/Intro.md'), 'utf8').catch(() => '')).toContain('# Intro')
})
