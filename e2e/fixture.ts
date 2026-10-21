// Shared by the e2e server and tests: a throwaway config and its contents.
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PORT = 7431
export const DIR = path.resolve(import.meta.dirname, '.tmp-config')
export const HOME = path.join(DIR, 'home')
export const SPAWN_LOG = path.join(DIR, 'spawned.log')
export const WORK_FILE = path.join(DIR, 'profiles/work.yaml')
export const PERSONAL_FILE = path.join(DIR, 'profiles/personal.yaml')
export const NOTES = path.join(HOME, 'notes')

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

export async function resetFixture() {
  await fsp.mkdir(path.join(DIR, 'profiles'), { recursive: true })
  // Tests create notes all over the fake home; start each one from a clean copy.
  await fsp.rm(HOME, { recursive: true, force: true })
  await fsp.mkdir(path.join(HOME, 'alpha'), { recursive: true })
  await fsp.writeFile(path.join(DIR, 'settings.yaml'), 'activeProfile: work\nprofiles: [work, personal]\n')
  await fsp.writeFile(WORK_FILE, WORK)
  await fsp.writeFile(PERSONAL_FILE, PERSONAL)
  await fsp.writeFile(SPAWN_LOG, '')
  for (const [rel, text] of Object.entries(NOTE_FILES)) {
    await fsp.mkdir(path.dirname(path.join(HOME, rel)), { recursive: true })
    await fsp.writeFile(path.join(HOME, rel), text)
  }
}
