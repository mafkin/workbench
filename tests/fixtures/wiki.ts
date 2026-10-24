// A wiki fixture for the store tests: the work profile of the old YAML fixture, as pages.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { migrateProfile } from '../../server/migrate.ts'

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
  'projects/Alpha.md': `---
folder: ~/alpha
---
# Alpha

## Workflow

- [All files](files:)
- [sources](src/)
- [readme](README.md)
- [build](<run:make all>)
`,
  'projects/Beta.md': `---
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
  'projects/Tuohi.md': '---\nfolder: ~/tuohi\n---\n# Tuohi\n\n## Workflow\n\n- [All files](files:)\n',
}

export async function writeWiki(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, text)
  }
}

/** settings.yaml naming the wikis; `profiles` maps ids to `~/…` folders. */
export async function writeSettings(dir: string, profiles: Record<string, string>, active = Object.keys(profiles)[0]) {
  await fsp.mkdir(dir, { recursive: true })
  const lines = Object.entries(profiles).map(([id, wiki]) => `  ${id}: ${wiki}`)
  await fsp.writeFile(path.join(dir, 'settings.yaml'), `activeProfile: ${active}\nprofiles:\n${lines.join('\n')}\n`)
}

/**
 * Turn a config folder's YAML profiles (`profiles/<id>.yaml`, as the older
 * tests write them) into wikis, and settings.yaml into the map naming them.
 * The YAML files are removed, so the store reads pages. A profile without a
 * notes folder gets `defaultWiki(id)` (else `<home>/notes`). Profiles already
 * in settings as wikis are kept.
 */
export async function migrateFixture(cfg: string, home: string, opts: { defaultWiki?: (id: string) => string } = {}) {
  const dir = path.join(cfg, 'profiles')
  const ids = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5))
  const settings = (parseYaml((await fsp.readFile(path.join(cfg, 'settings.yaml'), 'utf8').catch(() => '')) || '{}') ?? {}) as { activeProfile?: string; profiles?: string[] | Record<string, string> }
  const listed = Array.isArray(settings.profiles) ? settings.profiles : []
  const profiles: Record<string, string> = Array.isArray(settings.profiles) || !settings.profiles ? {} : { ...settings.profiles }
  const order = [...listed.filter((id) => ids.includes(id)), ...ids.filter((id) => !listed.includes(id)).sort()]
  for (const id of order) {
    const text = await fsp.readFile(path.join(dir, `${id}.yaml`), 'utf8')
    const wiki = /^notes:/m.test(text) ? undefined : opts.defaultWiki?.(id)
    const out = migrateProfile(text, { id, home, wiki })
    profiles[id] = out.wiki
    const root = out.wiki.startsWith('~') ? path.join(home, out.wiki.slice(1)) : out.wiki
    await writeWiki(root, out.files)
    await fsp.rm(path.join(dir, `${id}.yaml`))
  }
  const active = settings.activeProfile && profiles[settings.activeProfile] ? settings.activeProfile : Object.keys(profiles)[0]
  // Through the document, so a comment in the test's settings.yaml stays.
  const doc = parseDocument((await fsp.readFile(path.join(cfg, 'settings.yaml'), 'utf8').catch(() => '')) || '{}')
  doc.set('activeProfile', active)
  doc.set('profiles', doc.createNode(profiles))
  await fsp.writeFile(path.join(cfg, 'settings.yaml'), doc.toString())
  return profiles
}
