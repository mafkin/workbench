// `bin/workbench --migrate`: turn the profiles still in YAML into wikis (part 11).
// The running service picks the change up through settings.yaml.
import os from 'node:os'
import { defaultConfigDir } from './main.ts'
import { Wiki } from './wiki.ts'

const wiki = new Wiki(defaultConfigDir(), os.homedir())
await wiki.init({ seed: false, watch: false })
try {
  if (!wiki.legacy) {
    console.log('Every profile is already a wiki; nothing to move.')
  } else {
    const { moved } = await wiki.migrate()
    for (const id of moved) console.log(`${id}: moved to ${wiki.profile(id).wiki} (the YAML is kept as profiles/${id}.yaml.bak)`)
  }
} finally {
  wiki.close()
}
