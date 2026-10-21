// Shared by the e2e server and tests: a throwaway config and its contents.
import fsp from 'node:fs/promises'
import path from 'node:path'

export const PORT = 7431
export const DIR = path.resolve(import.meta.dirname, '.tmp-config')
export const HOME = path.join(DIR, 'home')
export const SPAWN_LOG = path.join(DIR, 'spawned.log')
export const WORK_FILE = path.join(DIR, 'profiles/work.yaml')

export const WORK = `# fixture: work profile
name: Work
accent: "#7d93ab"
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
`

export const PERSONAL = `name: Personal
accent: "#8fa58a"
sections:
  - title: Games
    items:
      - label: Tuohi
        type: folder
        path: ~/tuohi
`

export async function resetFixture() {
  await fsp.mkdir(path.join(DIR, 'profiles'), { recursive: true })
  await fsp.mkdir(path.join(HOME, 'alpha'), { recursive: true })
  await fsp.writeFile(path.join(DIR, 'settings.yaml'), 'activeProfile: work\nprofiles: [work, personal]\n')
  await fsp.writeFile(WORK_FILE, WORK)
  await fsp.writeFile(path.join(DIR, 'profiles/personal.yaml'), PERSONAL)
  await fsp.writeFile(SPAWN_LOG, '')
}
