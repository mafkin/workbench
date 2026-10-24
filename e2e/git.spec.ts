import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ALPHA, closeChats, DIR, HOME, resetFixture, WORK_DRAWER, writeWork } from './fixture.ts'

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation' })
const entry = (page: Page, label: string) => nav(page).locator('.item', { hasText: label })
const REMOTE = path.join(DIR, 'remote.git')
const OTHER = path.join(DIR, 'other')
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

/** Git as in a terminal, with the fake home's identity. */
function sh(cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_NOSYSTEM') delete env[k]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' })
}

const lines = (edit: (l: string[]) => void) => {
  const l = [...LINES]
  edit(l)
  return `${l.join('\n')}\n`
}

// Git is the drawer's tool on the rail; the fixture's drawer has Alpha's folder.
const railGit = (page: Page) => page.getByRole('complementary', { name: 'Drawer tools' }).getByRole('button', { name: 'Git', exact: true })
const openGit = async (page: Page) => {
  await railGit(page).click()
  await expect(page.locator('.git-branch')).toContainText('main')
}

test.beforeEach(async ({ page }) => {
  await closeChats()
  await resetFixture()
  await writeWork(WORK_DRAWER)
  fs.rmSync(REMOTE, { recursive: true, force: true })
  fs.rmSync(OTHER, { recursive: true, force: true })
  fs.writeFileSync(path.join(HOME, '.gitconfig'), '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n')
  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), `${LINES.join('\n')}\n`)
  sh(ALPHA, 'add', '-A')
  sh(ALPHA, 'commit', '-q', '-m', 'Start')
  sh(ALPHA, 'branch', '-M', 'main')
  sh(DIR, 'init', '-q', '--bare', REMOTE)
  sh(ALPHA, 'remote', 'add', 'origin', REMOTE)
  sh(ALPHA, 'push', '-q', '-u', 'origin', 'main')
  await page.goto('/')
  await expect(entry(page, 'Alpha')).toBeVisible()
  await expect(page.locator('.dot.live')).toBeVisible()
})

test.afterAll(closeChats)

test('stage one hunk, draft the message with claude, commit and push', async ({ page }) => {
  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), lines((l) => ((l[1] = 'LINE TWO'), (l[24] = 'LINE TWENTY-FIVE'))))
  await openGit(page)
  const changes = page.getByRole('listbox', { name: 'Changed files' })
  await changes.getByRole('option', { name: 'notes.txt' }).click()
  const hunks = page.locator('.git-detail .git-hunk')
  await expect(hunks).toHaveCount(2)
  await hunks.first().getByRole('button', { name: 'Stage hunk' }).click()
  await expect(page.getByRole('listbox', { name: 'Staged files' }).getByRole('option', { name: 'notes.txt' })).toBeVisible()
  await expect(hunks).toHaveCount(1)
  await expect(hunks.first()).toContainText('LINE TWENTY-FIVE')

  await page.getByRole('button', { name: 'Draft' }).click()
  await expect(page.getByLabel('Commit message')).toHaveValue(/^Update notes\.txt\n\nDrafted from \d+ lines; tools="".$/)
  await page.getByLabel('Commit message').fill('Say line two louder')
  await page.screenshot({ path: 'test-results/git-tab.png' })
  await page.getByRole('button', { name: /^Commit 1$/ }).click()
  await expect(page.locator('.toast').last()).toContainText('Say line two louder')
  await expect(page.getByRole('region', { name: 'History' }).locator('.git-subject').first()).toHaveText('Say line two louder')
  expect(sh(ALPHA, 'show', 'HEAD', '--', 'notes.txt')).toContain('+LINE TWO')
  expect(sh(ALPHA, 'diff')).toContain('+LINE TWENTY-FIVE')
  await expect(page.locator('.git-ab')).toContainText('↑1')

  // The nav shows uncommitted changes and a commit to push; Push clears the arrow.
  await expect(entry(page, 'Alpha').locator('.git-mark')).toHaveAttribute('aria-label', /\d+ uncommitted changes?, 1 to push/)
  await page.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(page.locator('.toast').last()).toContainText('Pushed main')
  await expect(page.locator('.git-ab')).toContainText('↑0')
  await expect(entry(page, 'Alpha').locator('.git-mark')).not.toHaveAttribute('aria-label', /to push/)
  expect(sh(REMOTE, 'log', '-1', '--format=%s')).toBe('Say line two louder\n')

  await page.getByRole('region', { name: 'History' }).locator('.git-commit-row').first().click()
  await expect(page.locator('.git-commit-files')).toContainText('notes.txt')
  await expect(page.locator('.git-detail .git-line.add')).toContainText('LINE TWO')
})

test('discard asks first and Undo brings the change back', async ({ page }) => {
  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), lines((l) => (l[0] = 'mine')))
  await openGit(page)
  await page.getByRole('button', { name: 'Discard notes.txt' }).click({ force: true })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('region', { name: 'Changes' })).toContainText('No changes.')
  expect(fs.readFileSync(path.join(ALPHA, 'notes.txt'), 'utf8')).toBe(`${LINES.join('\n')}\n`)
  await page.locator('.toast', { hasText: 'Discarded changes to notes.txt' }).getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('listbox', { name: 'Changed files' }).getByRole('option', { name: 'notes.txt' })).toBeVisible()
  expect(fs.readFileSync(path.join(ALPHA, 'notes.txt'), 'utf8')).toMatch(/^mine\n/)
})

test('make a branch, and switching with changes offers to stash them', async ({ page }) => {
  await openGit(page)
  await page.getByRole('button', { name: 'Branch' }).click()
  await page.getByRole('menuitem', { name: 'New branch…' }).click()
  await page.getByRole('dialog', { name: 'New branch' }).getByRole('textbox').fill('feature')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.locator('.git-branch')).toContainText('feature')

  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), lines((l) => (l[3] = 'on feature')))
  await expect(page.getByRole('listbox', { name: 'Changed files' }).getByRole('option', { name: 'notes.txt' })).toBeVisible()
  await page.getByRole('button', { name: 'Branch' }).click()
  await page.getByRole('menuitem', { name: /^main/ }).click()
  await page.getByRole('alertdialog', { name: 'Switch to main?' }).getByRole('button', { name: 'Stash them first' }).click()
  await expect(page.locator('.git-branch')).toContainText('main')
  await expect(page.getByRole('region', { name: 'Stashes' })).toContainText('Before switching to main')
  await page.getByRole('region', { name: 'Stashes' }).getByRole('button', { name: 'Pop' }).click()
  await expect(page.getByRole('listbox', { name: 'Changed files' }).getByRole('option', { name: 'notes.txt' })).toBeVisible()
})

test('a pull that conflicts: the banner, Ask claude, and Abort', async ({ page }) => {
  sh(DIR, 'clone', '-q', REMOTE, OTHER)
  fs.writeFileSync(path.join(OTHER, 'notes.txt'), lines((l) => (l[1] = 'theirs')))
  sh(OTHER, 'commit', '-qam', 'Theirs')
  sh(OTHER, 'push', '-q')
  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), lines((l) => (l[1] = 'ours')))
  sh(ALPHA, 'commit', '-qam', 'Ours')

  await openGit(page)
  await expect(page.locator('.git-ab')).toContainText('↓1')
  await page.getByRole('button', { name: 'Pull' }).click()
  await page.getByRole('alertdialog', { name: 'Merge to pull?' }).getByRole('button', { name: 'Merge' }).click()
  const banner = page.getByRole('alert', { name: 'Conflicts' })
  await expect(banner).toContainText('conflicts in 1 file')
  await expect(entry(page, 'Alpha').locator('.git-mark.conflict')).toHaveAttribute('aria-label', /^1 in conflict/)
  await expect(banner).toContainText('notes.txt')
  await page.screenshot({ path: 'test-results/git-conflict.png' })

  await banner.getByRole('button', { name: 'Ask claude about notes.txt' }).click()
  await expect(page.locator('.chat-terminal .xterm-rows')).toContainText('prompt=This repository has merge conflicts')
  await railGit(page).click()
  await page.getByRole('alert', { name: 'Conflicts' }).getByRole('button', { name: 'Abort merge' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Abort merge' }).click()
  await expect(page.getByRole('alert', { name: 'Conflicts' })).toHaveCount(0)
  expect(fs.readFileSync(path.join(ALPHA, 'notes.txt'), 'utf8')).toContain('ours')
})

test('Ctrl+K opens the drawer’s Git', async ({ page }) => {
  await page.keyboard.press('Control+k')
  await page.keyboard.type('git')
  await page.getByRole('option', { name: /^Git/ }).first().click()
  await expect(railGit(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.git-branch')).toContainText('main')
})
