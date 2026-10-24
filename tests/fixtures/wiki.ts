// A wiki fixture for the store tests: the work profile of the old YAML fixture, as pages.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { migrateProfile } from './pages-from-yaml.ts'

export const WORK_WIKI: Record<string, string> = {
  'index.md': `---
name: Work
accent: "#7d93ab"
---
Words about this profile.

## Projects
<!-- first entry comment -->
- [[Alpha]]
- [[Beta]]
- [Gamma](~/gamma.md)

## Tools
- [Echo tool](<run:echo hello>)

## Notes
- [Today](daily:)
- [[Ideas]]
- [Runbook](~/repo/RUNBOOK.md)
`,
  'pages/Alpha.md': `---
folder: ~/alpha
---
# Alpha

## Workflow

- [All files](files:)
- [sources](src/)
- [readme](README.md)
- [build](<run:make all>)
`,
  'pages/Beta.md': `---
folder: ~/beta
status: paused
---
# Beta
`,
  'Ideas.md': '# Ideas\n\nShip the notes part.\n',
  'Workflow.md': '# Workflow\n\nThe steps an item gets with Add profile steps.\n\n- [sources](src/)\n- [readme](README.md)\n- [build](<run:make all>)\n',
}

export const PERSONAL_WIKI: Record<string, string> = {
  'index.md': `---
name: Personal
accent: "#8fa58a"
---
## Games
- [[Tuohi]]
`,
  'pages/Tuohi.md': '---\nfolder: ~/tuohi\n---\n# Tuohi\n\n## Workflow\n\n- [All files](files:)\n',
}

export async function writeWiki(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, text)
  }
}

/** The Workbench folder the unit tests use: `<home>/wb`, so the work profile is `~/wb/work` (part 13). */
export const wbDir = (home: string) => path.join(home, 'wb')

/** settings.yaml in the Workbench folder: the profile ids in order (each a subfolder). */
export async function writeSettings(dir: string, ids: string[], active = ids[0]) {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'settings.yaml'), `activeProfile: ${active}\nprofiles:\n${ids.map((id) => `  - ${id}`).join('\n')}\n`)
}

/**
 * Turn a test's YAML profiles (`<cfg>/profiles/<id>.yaml`, the fixtures'
 * language) into wikis inside the Workbench folder `<home>/wb` (`<id>/` each),
 * with its settings.yaml listing them in the order of `<cfg>/settings.yaml`
 * (else alphabetical). The YAML files stay, so a test can edit and convert
 * again. Returns the Workbench folder.
 */
export async function migrateFixture(cfg: string, home: string, opts: { dir?: string } = {}): Promise<string> {
  const dir = opts.dir ?? wbDir(home)
  const yamlDir = path.join(cfg, 'profiles')
  const ids = (await fsp.readdir(yamlDir).catch(() => [] as string[])).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5))
  const settings = (parseYaml((await fsp.readFile(path.join(cfg, 'settings.yaml'), 'utf8').catch(() => '')) || '{}') ?? {}) as { activeProfile?: string; profiles?: string[] | Record<string, string> }
  const listed = Array.isArray(settings.profiles) ? settings.profiles : Object.keys(settings.profiles ?? {})
  const order = [...listed.filter((id) => ids.includes(id)), ...ids.filter((id) => !listed.includes(id)).sort()]
  for (const id of order) {
    const text = await fsp.readFile(path.join(yamlDir, `${id}.yaml`), 'utf8')
    const out = migrateProfile(text, { id, wiki: path.join(dir, id) })
    await writeWiki(path.join(dir, id), out.files)
  }
  const active = settings.activeProfile && order.includes(settings.activeProfile) ? settings.activeProfile : order[0]
  // Through the document, so a comment in the test's settings.yaml stays.
  const doc = parseDocument((await fsp.readFile(path.join(cfg, 'settings.yaml'), 'utf8').catch(() => '')) || '{}')
  doc.set('activeProfile', active)
  doc.set('profiles', doc.createNode(order))
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'settings.yaml'), doc.toString())
  return dir
}
