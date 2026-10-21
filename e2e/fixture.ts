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
/** Where the fake `gio trash` puts files, outside the fake home. */
export const TRASH = path.join(DIR, 'trash')

export const WORK = `# fixture: work profile
name: Work
accent: "#7d93ab"
notes: ~/notes
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
  // A one-page PDF; viewers rebuild the missing cross-reference table.
  'spec.pdf': '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
}

export async function resetFixture() {
  await fsp.mkdir(path.join(DIR, 'profiles'), { recursive: true })
  // Tests create notes and files all over the fake home; start each one from a clean copy.
  await fsp.rm(HOME, { recursive: true, force: true })
  await fsp.rm(TRASH, { recursive: true, force: true })
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
