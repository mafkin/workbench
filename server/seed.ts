// First-run config: a starting point built from folders that exist on this
// machine. Everything here can be changed in the app or by editing the files.
// The profiles are written as YAML here and turned into pages by `seedWiki`,
// so the first run starts with wikis (part 11).
import fsp from 'node:fs/promises'
import path from 'node:path'
import { migrateProfile } from './migrate.ts'

const HEADER = `# Edit this file by hand or in Workbench (pencil at the top of the nav panel).
# Your comments are kept when the app saves.
# Entry types: folder (a project), note, daily, link, launch, and group (one level of entries inside).
# notes: is the folder for new notes, daily notes, search and [[wiki links]].
`

const SETTINGS = `# Workbench settings. Each file in profiles/ is a profile; this sets their order.
activeProfile: work
profiles: [work, personal]
`

const WORK = `${HEADER}name: Work
accent: "#7d93ab"
home: ~/Documents/work
notes: ~/Documents/work/notes
sections:
  - title: Projects
    items:
      - label: IFC Checker
        type: folder
        path: ~/ifc_checker_project
      - label: IFC releases
        type: folder
        path: ~/ifc_checker_releases
      - label: look-ifc deploy
        type: folder
        path: ~/look-ifc-deploy
      - label: Lupapiste support agent
        type: folder
        path: ~/Projects/lupapiste-support-agent
      - label: WFS testing
        type: folder
        path: ~/wfs_testing
      - label: Webinar
        type: folder
        path: ~/webinar_work
  - title: Docs
    items:
      - label: Work documents
        type: folder
        path: ~/Documents/work
      - label: Specifications
        type: folder
        path: ~/Documents/work/specifications
      - label: Presentations
        type: folder
        path: ~/Documents/work/presentations
      - label: Deploy runbook
        type: note
        path: ~/deploy-tools/RUNBOOK.md
  - title: Tools
    items:
      - label: Claude in IFC Checker
        type: launch
        command: gnome-terminal
        args: ["--working-directory=~/ifc_checker_project", "--", "claude"]
  - title: Notes
    items:
      - label: Today
        type: daily
`

const PERSONAL = `${HEADER}name: Personal
accent: "#8fa58a"
home: "~"            # a bare ~ means null in YAML, so it is quoted
notes: ~/Documents/notes
sections:
  - title: Games & dev
    items:
      - label: Tuohi
        type: folder
        path: ~/Projects/tuohi
      - label: Wargame
        type: folder
        path: ~/wargame
      - label: PF2e AI arbiter
        type: folder
        path: ~/pf2e-ai-arbiter
      - label: VTT automaton
        type: folder
        path: ~/vtt-automaton
  - title: 3D & assets
    items:
      - label: wip_assets
        type: folder
        path: ~/Projects/wip_assets
      - label: Blender
        type: launch
        command: blender
      - label: "Godot: Tuohi"
        type: launch
        command: godot
        args: ["--editor", "--path", "~/Projects/tuohi"]
  - title: Documents
    items:
      - label: Documents
        type: folder
        path: ~/Documents
  - title: Notes
    items:
      - label: Today
        type: daily
`

export async function seedConfig(dir: string): Promise<void> {
  await fsp.mkdir(path.join(dir, 'profiles'), { recursive: true })
  const files: [string, string][] = [
    ['settings.yaml', SETTINGS],
    ['profiles/work.yaml', WORK],
    ['profiles/personal.yaml', PERSONAL],
  ]
  for (const [name, text] of files) {
    // 'wx' never overwrites a file the user already has.
    await fsp.writeFile(path.join(dir, name), text, { flag: 'wx' }).catch((err) => {
      if (err.code !== 'EEXIST') throw err
    })
  }
}

/** The first-run wikis: settings.yaml naming them, and the pages of each (never over existing files). */
export async function seedWiki(dir: string, home: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  const profiles: Record<string, string> = {}
  for (const [id, text] of [
    ['work', WORK],
    ['personal', PERSONAL],
  ] as const) {
    const { wiki, files } = migrateProfile(text, { id, home })
    profiles[id] = wiki
    const root = wiki.startsWith('~') ? path.join(home, wiki.slice(1)) : wiki
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content, { flag: 'wx' }).catch((err) => {
        if (err.code !== 'EEXIST') throw err
      })
    }
  }
  const settings = `# Workbench settings: each profile is a wiki folder; this sets their order and the active one.\nactiveProfile: work\nprofiles:\n${Object.entries(profiles)
    .map(([id, wiki]) => `  ${id}: ${wiki}`)
    .join('\n')}\n`
  await fsp.writeFile(path.join(dir, 'settings.yaml'), settings, { flag: 'wx' }).catch((err) => {
    if (err.code !== 'EEXIST') throw err
  })
}
