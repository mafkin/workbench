import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, CLAUDE_SECRETS, HOME, resetFixture, WORK_FILE, writeClaudeSetup } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const kinds = (page: Page) => page.getByRole('tablist', { name: 'Kinds' })
const kind = (page: Page, name: string) => kinds(page).getByRole('tab', { name: new RegExp(`^${name}`) })
const rows = (page: Page) => page.getByRole('listbox').getByRole('option')
const option = (page: Page, name: string) => rows(page).filter({ has: page.locator('.setup-row-title', { hasText: new RegExp(`^${name}$`) }) })
const details = (page: Page) => page.getByLabel('Details')

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Claude setup', exact: true }).click()
  await expect(page.locator('.page-title')).toHaveText('Claude setup')
}

test.beforeEach(async ({ page }) => {
  await resetFixture()
  await writeClaudeSetup()
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
})

test('the sidebar button opens Claude setup; a skill shows its file and body', async ({ page }) => {
  await openSetup(page)
  await expect(page.locator('.crumbs')).toContainText('Work/Claude setup')
  await kind(page, 'Skills').click()
  await expect(kind(page, 'Skills')).toContainText('4')
  await expect(kind(page, 'MCP servers')).toContainText('3')
  await option(page, '/review').click()
  await expect(details(page)).toContainText('Reviews a change before it ships')
  await expect(details(page)).toContainText('~/.claude/skills/review/SKILL.md')
  await expect(details(page).locator('.markdown h1')).toHaveText('Review')
  await expect(details(page).locator('.markdown strong')).toHaveText('run the tests')
  await expect(option(page, '/toolkit:lint').locator('.scope-badge')).toHaveText('toolkit')
  await expect(option(page, '/review').locator('.scope-badge')).toHaveText('Yours')
  await page.screenshot({ path: 'test-results/setup-skills.png' })

  // Back returns to where you were.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('.setup')).toHaveCount(0)
})

test('Check starts an MCP server and lists its tools; secrets never reach the page', async ({ page }) => {
  const responses: string[] = []
  page.on('response', async (res) => {
    if (res.url().includes('/api/claude/')) responses.push(await res.text().catch(() => ''))
  })
  await openSetup(page)
  await kind(page, 'MCP servers').click()
  await option(page, 'tools').click()
  await expect(details(page)).toContainText('FAKE_MCP_TOKEN')
  await expect(details(page)).toContainText('••••••')
  await details(page).getByRole('button', { name: 'Check' }).click()
  await expect(details(page).getByRole('status')).toContainText('fake-mcp 1.2.3')
  await expect(details(page).locator('.tool-list li')).toHaveCount(3)
  await expect(option(page, 'tools').locator('.check-dot.ok')).toBeVisible()
  await page.screenshot({ path: 'test-results/setup-mcp-check.png' })

  await option(page, 'broken').click()
  await details(page).getByRole('button', { name: 'Check' }).click()
  await expect(details(page).getByRole('status')).toContainText('exited with code 3')
  await expect(details(page).locator('.setup-log')).toContainText('cannot reach the database')

  await page.getByRole('button', { name: 'Check all' }).click()
  await expect(option(page, 'search').locator('.check-dot.bad')).toBeVisible({ timeout: 10_000 })
  await expect(option(page, 'broken').locator('.check-dot.bad')).toBeVisible()

  // Everything the page shows, and every response it got.
  for (const kindName of ['Skills', 'Agents', 'Commands', 'Hooks', 'Plugins']) await kind(page, kindName).click()
  const html = await page.content()
  for (const s of CLAUDE_SECRETS) {
    expect(html).not.toContain(s)
    for (const r of responses) expect(r).not.toContain(s)
  }
  expect(responses.length).toBeGreaterThan(3)
})

test("a project's Claude setup tab adds its own and local items; an unapproved server asks first", async ({ page }) => {
  await entry(page, 'Alpha').click()
  await page.getByRole('tablist', { name: 'Workflow' }).getByRole('tab', { name: 'Claude setup' }).click()
  await expect(page.locator('.crumbs')).toContainText('Alpha/Claude setup')
  await expect(page.locator('.setup-for')).toContainText('~/alpha')
  await kind(page, 'Skills').click()
  await expect(option(page, '/alpha-notes').locator('.scope-badge')).toHaveText('Project')

  await kind(page, 'MCP servers').click()
  await expect(option(page, 'scratch').locator('.scope-badge')).toHaveText('Local')
  await expect(option(page, 'alpha-db')).toContainText('not approved')
  await option(page, 'alpha-db').click()
  await details(page).getByRole('button', { name: 'Check' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('~/alpha/.mcp.json')
  await page.screenshot({ path: 'test-results/setup-confirm.png' })
  await confirm.getByRole('button', { name: 'Check' }).click()
  await expect(details(page).getByRole('status')).toContainText('fake-mcp')
  await expect(details(page).locator('.tool-list')).toContainText(`Runs in ${ALPHA}`)

  await kind(page, 'Hooks').click()
  await expect(option(page, 'Stop').locator('.scope-badge')).toHaveText('Project')
  await option(page, 'PreToolUse · Bash').click()
  await expect(details(page).locator('.setup-log')).toHaveText('guard.sh --token ••••••')
  await page.screenshot({ path: 'test-results/setup-project-tab.png' })

  // The tab is remembered for the project.
  await page.reload()
  await expect(page.locator('.setup-for')).toContainText('~/alpha')
})

test('a plugin’s details jump to what it brings; For picks a project', async ({ page }) => {
  await openSetup(page)
  await kind(page, 'Plugins').click()
  await option(page, 'toolkit').click()
  await expect(details(page)).toContainText('Handy tools for every project')
  await expect(details(page)).toContainText('github.com/acme/claude-plugins')
  await expect(details(page)).toContainText('On in ~/.claude/settings.json')
  await page.screenshot({ path: 'test-results/setup-plugin.png' })
  await details(page).getByRole('button', { name: '2 skills' }).click()
  await expect(kind(page, 'Skills')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /Plugin: toolkit/ })).toBeVisible()
  await expect(rows(page)).toHaveCount(2)

  await page.getByRole('button', { name: /Plugin: toolkit/ }).click()
  await expect(option(page, '/alpha-notes')).toHaveCount(0)
  await page.getByRole('combobox', { name: 'For' }).selectOption({ label: 'Alpha (~/alpha)' })
  await expect(option(page, '/alpha-notes')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'For' })).toHaveValue('~/alpha')
})

const offInAlpha = () => {
  const json = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  return json.projects?.[ALPHA]?.disabledMcpServers ?? []
}

test('a switch turns an MCP server off in the project, like /mcp; off servers fold away; Undo', async ({ page }) => {
  await entry(page, 'Alpha').click()
  await page.getByRole('tablist', { name: 'Workflow' }).getByRole('tab', { name: 'Claude setup' }).click()
  await kind(page, 'MCP servers').click()
  await expect(page.locator('.setup-switch-hint')).toContainText('like /mcp')
  await option(page, 'tools').getByRole('switch').click()
  await expect(page.locator('.toast')).toContainText('tools off here')
  await expect(option(page, 'tools')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '1 off · Show' })).toBeVisible()
  expect(offInAlpha()).toEqual(['tools'])
  await page.screenshot({ path: 'test-results/setup-mcp-switch.png' })

  await page.getByRole('button', { name: '1 off · Show' }).click()
  await expect(option(page, 'tools').getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await expect(option(page, 'tools')).toContainText('off')
  // A filter finds off servers too.
  await page.getByRole('button', { name: '1 off · Hide' }).click()
  await page.getByLabel('Filter').fill('too')
  await expect(option(page, 'tools')).toBeVisible()
  await page.getByLabel('Filter').fill('')

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click()
  await expect(option(page, 'tools').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('button', { name: /off · Show/ })).toHaveCount(0)
  expect(offInAlpha()).toEqual([])
})

test('everywhere, a plugin’s servers go off as the profile’s defaults, in every project', async ({ page }) => {
  await openSetup(page)
  await kind(page, 'Plugins').click()
  await option(page, 'toolkit').click()
  await expect(details(page)).toContainText('1 of 1 on')
  await details(page).getByRole('button', { name: 'Turn all off' }).click()
  await expect(details(page)).toContainText('0 of 1 on')
  await expect.poll(() => fs.readFileSync(WORK_FILE, 'utf8')).toContain('plugin:toolkit:search')
  expect(offInAlpha()).toEqual(['plugin:toolkit:search'])
  await page.screenshot({ path: 'test-results/setup-plugin-off.png' })

  await kind(page, 'MCP servers').click()
  await expect(page.locator('.setup-switch-hint')).toContainText('this profile’s defaults')
  await page.getByRole('button', { name: '1 off · Show' }).click()
  await expect(option(page, 'search').getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await option(page, 'search').click()
  await expect(details(page).locator('.setup-note')).toContainText('Off by default')
  await expect(details(page)).toContainText('plugin:toolkit:search')

  // On again everywhere: out of the file and on in Alpha.
  await option(page, 'search').getByRole('switch').click()
  await expect(option(page, 'search').getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => fs.readFileSync(WORK_FILE, 'utf8')).not.toContain('mcpOff')
  expect(offInAlpha()).toEqual([])
})

