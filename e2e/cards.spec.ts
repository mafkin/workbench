import fsp from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { page as wikiPage, resetFixture, SPAWN_LOG, WORK, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workflow' })
const alphaPage = () => fsp.readFile(wikiPage('projects/Alpha.md'), 'utf8')

/** Write the work profile with extra lines under Alpha (and Beta); the app picks up the hand edit. */
async function withProjects(alpha: string, beta = '') {
  const text = WORK.replace('        path: ~/alpha\n', `        path: ~/alpha\n${alpha}`).replace('        path: ~/beta\n', `        path: ~/beta\n${beta}`)
  await writeWork(text)
  return text
}

async function pick(page: Page, button: string, item: string) {
  await page.getByRole('button', { name: button }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test('the project header is the card: status, category, description and pin write the page’s frontmatter', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await pick(page, 'Status: Active', 'Paused')
  await expect(page.getByRole('button', { name: 'Status: Paused' })).toBeVisible()
  await expect(entry(page, 'Alpha').locator('.status-dot')).toHaveClass(/paused/)

  await page.getByRole('button', { name: 'Category' }).click()
  await page.getByRole('menuitem', { name: 'New category…' }).click()
  await page.getByLabel('New category').fill('client')
  await page.keyboard.press('Enter')
  await expect(page.locator('.category-chip')).toHaveText('client')

  await page.getByText('Add a description').click()
  await page.getByLabel('Description').fill('The alpha project')
  await page.keyboard.press('Enter')
  await expect(page.locator('.card-description')).toHaveText('The alpha project')

  await page.getByRole('button', { name: 'Pinned' }).click()
  await expect(entry(page, 'Alpha').locator('.pin-mark')).toBeVisible()
  await page.screenshot({ path: 'test-results/cards-header.png' })

  await expect.poll(alphaPage).toContain('pinned: true')
  expect(await alphaPage()).toMatch(/^---\nfolder: ~\/alpha\nstatus: paused\ncategory: client\ndescription: The alpha project\npinned: true\n---\n# Alpha\n/)

  await pick(page, 'Status: Paused', 'Active')
  await expect.poll(alphaPage).not.toContain('status:')
})

test('the nav puts pinned projects first and hides archived ones until asked', async ({ page }) => {
  await withProjects('        status: archived\n', '        pinned: true\n')
  const projects = nav(page).locator('.section', { hasText: 'Projects' }).locator('.item .label')
  await expect(projects).toHaveText(['Beta', 'Gamma'])
  await nav(page).getByRole('button', { name: '1 archived · Show' }).click()
  await expect(projects).toHaveText(['Beta', 'Alpha', 'Gamma'])
  await expect(entry(page, 'Alpha')).toHaveClass(/archived/)
  await page.screenshot({ path: 'test-results/cards-nav.png' })

  // While editing, the file's own order shows, so drags land where they look.
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await expect(projects).toHaveText(['Alpha', 'Beta', 'Gamma'])
})

test("a project's right-click menu archives it, with Undo", async ({ page }) => {
  const before = await alphaPage()
  await entry(page, 'Alpha').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(entry(page, 'Alpha')).toHaveCount(0)
  await expect.poll(alphaPage).toContain('status: archived')
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(entry(page, 'Alpha')).toBeVisible()
  expect(await alphaPage()).toBe(before)
})

test('a report tab shows the HTML report with its own stylesheet, sandboxed', async ({ page }) => {
  await withProjects('        steps:\n          - { label: tests, type: report, path: reports/index.html }\n')
  await entry(page, 'Alpha').click()
  // The only step fills the page: no tab row.
  await expect(tabs(page)).toHaveCount(0)
  const frame = page.locator('.report-frame')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-popups allow-forms')
  const h1 = page.frameLocator('.report-frame').locator('h1')
  await expect(h1).toHaveText('Test report')
  await expect(h1).toHaveCSS('color', 'rgb(200, 30, 30)')
  await page.screenshot({ path: 'test-results/cards-report.png' })
})

test('a file tab shows one file large', async ({ page }) => {
  await withProjects('        steps:\n          - { label: All files, type: files }\n          - { label: diagram, type: file, path: diagram.svg }\n')
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('tab', { name: 'diagram' }).click()
  const img = page.locator('.file-step-body img')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(160)
})

test('a link tab opens the browser and stays on the current tab', async ({ page }) => {
  await withProjects('        steps:\n          - { label: All files, type: files }\n          - { label: board, type: link, url: "https://example.com/board" }\n')
  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'board' }).click()
  await expect(page.locator('.toast')).toContainText('Opened board')
  expect(await fsp.readFile(SPAWN_LOG, 'utf8')).toBe('xdg-open https://example.com/board\n')
  await expect(tabs(page).getByRole('tab', { name: 'All files' })).toHaveAttribute('aria-selected', 'true')
})

test('a new entry is an item with no kind to pick; the step dialog offers every kind of step', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit navigation' }).click()
  await page.getByRole('button', { name: 'Add entry to Tools' }).click()
  const add = page.getByRole('form', { name: 'Add item' })
  await expect(add.getByRole('radio')).toHaveCount(0)
  await expect(add.getByLabel('Folder (optional)')).toBeVisible()
  await add.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Edit navigation' }).click()

  await entry(page, 'Alpha').click()
  await tabs(page).getByRole('button', { name: 'Add step' }).click()
  await expect(page.getByRole('form', { name: 'Add step' }).getByRole('radio')).toHaveText(['File browser', 'Folder', 'Note', 'Git', 'Claude setup', 'Report', 'File', 'Chat', 'Launcher', 'Link'])
})
