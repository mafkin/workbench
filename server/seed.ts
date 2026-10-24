// A fresh Workbench folder (part 13): settings.yaml and one profile with one
// drawer, its nav empty. Nothing here points at any folder of the user's;
// entries are added in the app. Never over files that exist.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ACCENTS, noteFileName } from '../shared/config-schema.ts'

export interface FirstProfile {
  id: string
  name: string
}

/** The pages of a new profile: `index.md` listing one drawer, the drawer's page, and the drawer's folder. */
export function profilePages(name: string, accent: string): Record<string, string> {
  const page = noteFileName(name) ?? 'Main.md'
  return {
    'index.md': `---\nname: ${JSON.stringify(name)}\naccent: "${accent}"\n---\n## Drawers\n\n- [[drawers/${page.replace(/\.md$/, '')}]]\n`,
    [`drawers/${page}`]: `## ${name}\n`,
  }
}

/** The drawer folder a fresh profile gets, next to its page. */
export const firstDrawerFolder = (name: string) => `drawers/${(noteFileName(name) ?? 'Main.md').replace(/\.md$/, '')}`

async function writeNew(file: string, text: string) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, { flag: 'wx' }).catch((err) => {
    if (err.code !== 'EEXIST') throw err
  })
}

/** Make `dir` a Workbench folder with its first profile; files that exist are kept. */
export async function seedWorkbench(dir: string, first: FirstProfile): Promise<void> {
  const root = path.join(dir, first.id)
  for (const [rel, text] of Object.entries(profilePages(first.name, ACCENTS[0]))) await writeNew(path.join(root, rel), text)
  await fsp.mkdir(path.join(root, firstDrawerFolder(first.name)), { recursive: true })
  await writeNew(path.join(dir, 'settings.yaml'), `# Workbench settings: the profiles (each a folder here), in the switcher's order, and the active one.\nactiveProfile: ${first.id}\nprofiles:\n  - ${first.id}\n`)
}
