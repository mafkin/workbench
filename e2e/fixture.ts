// Shared by the e2e server and tests: a throwaway config and its contents.
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PORT = 7431
export const DIR = path.resolve(import.meta.dirname, '.tmp-config')
export const HOME = path.join(DIR, 'home')
export const SPAWN_LOG = path.join(DIR, 'spawned.log')
export const WORK_FILE = path.join(DIR, 'profiles/work.yaml')
export const PERSONAL_FILE = path.join(DIR, 'profiles/personal.yaml')
export const NOTES = path.join(HOME, 'notes')
export const ALPHA = path.join(HOME, 'alpha')
/** The fake home's Trash, where the fake `gio trash` puts files (with .trashinfo, as GNOME does). */
export const TRASH_DIR = path.join(HOME, '.local/share/Trash')
export const TRASH = path.join(TRASH_DIR, 'files')
/** Stand-ins for claude and the login shell; chats in tests never run the real ones. */
export const FAKE_CLAUDE = path.resolve(import.meta.dirname, '../tests/fixtures/fake-claude.mjs')
export const FAKE_SHELL = path.resolve(import.meta.dirname, '../tests/fixtures/fake-shell.mjs')
/** A stand-in MCP server for the Claude setup checks. */
export const FAKE_MCP = path.resolve(import.meta.dirname, '../tests/fixtures/fake-mcp.mjs')
/** Claude's managed settings folder for the e2e server (empty unless a test writes it). */
export const MANAGED = path.join(DIR, 'managed')

export const WORK = `# fixture: work profile
name: Work
accent: "#7d93ab"
notes: ~/notes
# Every project starts with these
workflow:
  - { label: sources, type: folder, path: src }
  - { label: readme, type: note, path: README.md }
  - { label: build, type: launch, command: make, args: [all] }
sections:
  - title: Projects
    items:
      # first entry comment
      - label: Alpha
        type: folder
        path: ~/alpha
      - label: Beta
        type: folder
        path: ~/beta
      - label: Gamma
        type: note
        path: ~/gamma.md
  - title: Tools
    items:
      - label: Echo tool
        type: launch
        command: echo
        args: [hello]
  - title: Notes
    items:
      - label: Today
        type: daily
      - label: Ideas
        type: note
        path: ~/notes/Ideas.md
      - label: Runbook
        type: note
        path: ~/repo/RUNBOOK.md
`

// Personal has no notes folder, to show the hint.
export const PERSONAL = `name: Personal
accent: "#8fa58a"
sections:
  - title: Games
    items:
      - label: Tuohi
        type: folder
        path: ~/tuohi
`

export const IDEAS = `# Ideas

Ship the **notes** part, then [[Deploy plan]]. Not written yet: [[Missing page]].

## Checklist

- [x] Render Markdown
- [ ] Wiki links

| Part | Status |
| ---- | ------ |
| 1    | Done   |

\`inline code\` and a [link](https://example.com).

![diagram](img/diagram.svg)
`

export const DEPLOY_PLAN = `# Deploy plan

Tag the release, deploy, and keep a rollback ready.
`

const NOTE_FILES: Record<string, string> = {
  'notes/Ideas.md': IDEAS,
  'notes/work/Deploy plan.md': DEPLOY_PLAN,
  'notes/templates/daily.md': '# {{date}}\n\n## Plan\n\n- [ ] \n',
  'notes/img/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#7d93ab"/></svg>',
  'repo/RUNBOOK.md': '# Runbook\n\nDeploy steps. See [[Ideas]].\n',
}

/** A silent 0.1 s WAV, so the audio preview has something real to load. */
function wav(): Buffer {
  const rate = 8000
  const data = Buffer.alloc(rate / 10)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate, 28)
  head.writeUInt16LE(1, 32)
  head.writeUInt16LE(8, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data.fill(128)])
}

// Alpha is a small git project: a dotfile, files .gitignore excludes, code, Markdown and media.
const ALPHA_FILES: Record<string, string | Buffer> = {
  'README.md': '# Alpha\n\nThe alpha project. See [[Ideas]].\n',
  'src/main.py': 'print("hello from alpha")\n',
  'src/util.py': 'def util():\n    return 1\n',
  '.env': 'TOKEN=not-a-real-token\n',
  '.gitignore': 'dist/\n*.log\n',
  'dist/bundle.js': 'console.log(1)\n',
  'build.log': 'built\n',
  'diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" rx="8" fill="#7d93ab"/><circle cx="80" cy="45" r="22" fill="#141518"/></svg>',
  'chime.wav': wav(),
  // An HTML report that loads a stylesheet next to it.
  'reports/index.html': '<!doctype html><link rel="stylesheet" href="style.css"><h1>Test report</h1><p>12 passed</p>',
  'reports/style.css': 'h1 { color: rgb(200, 30, 30); }',
  // A one-page PDF; viewers rebuild the missing cross-reference table.
  'spec.pdf': '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
}

export async function resetFixture() {
  await fsp.mkdir(path.join(DIR, 'profiles'), { recursive: true })
  // Profiles a test added would linger in the switcher.
  for (const f of await fsp.readdir(path.join(DIR, 'profiles'))) {
    if (f !== 'work.yaml' && f !== 'personal.yaml') await fsp.rm(path.join(DIR, 'profiles', f), { force: true })
  }
  // Tests create notes and files all over the fake home; start each one from a clean copy.
  await fsp.rm(HOME, { recursive: true, force: true })
  await fsp.rm(TRASH, { recursive: true, force: true })
  await fsp.rm(path.join(DIR, 'backgrounds'), { recursive: true, force: true })
  await fsp.rm(MANAGED, { recursive: true, force: true })
  await fsp.mkdir(ALPHA, { recursive: true })
  for (const [rel, data] of Object.entries(ALPHA_FILES)) {
    await fsp.mkdir(path.dirname(path.join(ALPHA, rel)), { recursive: true })
    await fsp.writeFile(path.join(ALPHA, rel), data)
  }
  execFileSync('git', ['init', '-q'], { cwd: ALPHA })
  await fsp.writeFile(path.join(DIR, 'settings.yaml'), 'activeProfile: work\nprofiles: [work, personal]\n')
  await fsp.writeFile(WORK_FILE, WORK)
  await fsp.writeFile(PERSONAL_FILE, PERSONAL)
  await fsp.writeFile(SPAWN_LOG, '')
  for (const [rel, text] of Object.entries(NOTE_FILES)) {
    await fsp.mkdir(path.dirname(path.join(HOME, rel)), { recursive: true })
    await fsp.writeFile(path.join(HOME, rel), text)
  }
}

/** Secret values in the fake Claude setup; none may reach the page. */
export const CLAUDE_SECRETS = ['E2E-OAUTH-SECRET', 'E2E-SECRET-TOKEN', 'E2E-URL-SECRET', 'E2E-HOOK-SECRET', 'E2E-PLUGIN-SECRET']

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

/**
 * A Claude setup in the fake home: your skills, agent, command, hook and MCP
 * servers, an enabled plugin, and Alpha's own (.mcp.json, .claude/). Only the
 * Claude setup tests write it, so other tests see Alpha as before.
 */
export async function writeClaudeSetup() {
  const claude = path.join(HOME, '.claude')
  const toolkit = path.join(claude, 'plugins/cache/acme/toolkit/1.2.0')
  const files: Record<string, string | object> = {
    [path.join(HOME, '.claude.json')]: {
      oauthAccount: { emailAddress: 'me@example.com', accessToken: 'E2E-OAUTH-SECRET' },
      mcpServers: {
        tools: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_TOKEN: 'E2E-SECRET-TOKEN' } },
        broken: { command: process.execPath, args: [FAKE_MCP], env: { FAKE_MCP_MODE: 'crash' } },
      },
      projects: { [ALPHA]: { mcpServers: { scratch: { type: 'http', url: 'http://127.0.0.1:9/mcp?key=E2E-URL-SECRET' } } } },
    },
    [path.join(claude, 'settings.json')]: {
      enabledPlugins: { 'toolkit@acme': true },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh --token E2E-HOOK-SECRET', timeout: 30 }] }] },
    },
    [path.join(claude, 'skills/review/SKILL.md')]: skill('review', 'Reviews a change before it ships', '# Review\n\nRead the diff, then **run the tests**.\n\n- Check the names\n- Check the tests'),
    [path.join(claude, 'skills/deploy/SKILL.md')]: skill('deploy', 'Ships the current branch', 'Tag, push, watch the deploy.'),
    [path.join(claude, 'agents/critic.md')]: skill('critic', 'Finds the weak spots in a plan', 'Be blunt, be kind.'),
    [path.join(claude, 'commands/release.md')]: '---\ndescription: Cuts a release\nargument-hint: <version>\n---\nRelease $ARGUMENTS\n',
    [path.join(claude, 'plugins/installed_plugins.json')]: { version: 2, plugins: { 'toolkit@acme': [{ scope: 'user', installPath: toolkit, version: '1.2.0' }] } },
    [path.join(claude, 'plugins/known_marketplaces.json')]: { acme: { source: { source: 'github', repo: 'acme/claude-plugins' } } },
    [path.join(toolkit, '.claude-plugin/plugin.json')]: { name: 'toolkit', version: '1.2.0', description: 'Handy tools for every project', author: { name: 'Acme' } },
    [path.join(toolkit, 'skills/lint/SKILL.md')]: skill('lint', 'Lints the changed files', 'Run the linter.'),
    [path.join(toolkit, 'skills/format/SKILL.md')]: skill('format', 'Formats the changed files', 'Run the formatter.'),
    [path.join(toolkit, 'commands/todo.md')]: '---\ndescription: Lists the TODOs\n---\nFind TODOs\n',
    [path.join(toolkit, '.mcp.json')]: { mcpServers: { search: { type: 'http', url: 'https://search.example/mcp', headers: { Authorization: 'Bearer E2E-PLUGIN-SECRET' } } } },
    [path.join(ALPHA, '.mcp.json')]: { mcpServers: { 'alpha-db': { command: process.execPath, args: [FAKE_MCP] } } },
    [path.join(ALPHA, '.claude/settings.json')]: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check the tests ran' }] }] } },
    [path.join(ALPHA, '.claude/skills/alpha-notes/SKILL.md')]: skill('alpha-notes', 'How Alpha is laid out', 'Code in src/, reports in reports/.'),
  }
  for (const [file, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

/** Close every chat the service holds, so each test starts without any. */
export async function closeChats() {
  const headers = { 'x-workbench': '1' }
  for (const profile of ['work', 'personal']) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/chats?profile=${profile}`, { headers })
    for (const chat of (await res.json()) as { id: string }[]) {
      await fetch(`http://127.0.0.1:${PORT}/api/chats/${chat.id}`, { method: 'DELETE', headers })
    }
  }
}
