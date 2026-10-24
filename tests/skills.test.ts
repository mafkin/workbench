import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SetupDoc } from '../shared/claude-setup.ts'
import { Profile, type NavItem } from '../shared/config-schema.ts'
import { pinnedSkills, pluginDirsIn, resolveSkills, SkillBundles, skillsPrompt, wikiSkills } from '../server/skills.ts'

let dir: string
let wiki: string

const doc = (name: string, description: string, overriddenBy?: string): SetupDoc => ({ id: `s:${name}`, kind: 'skill', name, description, scope: 'user', path: `~/.claude/skills/${name}/SKILL.md`, fields: [], overriddenBy })

async function skill(name: string, description: string) {
  await fsp.mkdir(path.join(wiki, 'skills', name), { recursive: true })
  await fsp.writeFile(path.join(wiki, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
}

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-skills-'))
  wiki = path.join(dir, 'notes')
  await fsp.mkdir(wiki, { recursive: true })
})

afterEach(() => fsp.rm(dir, { recursive: true, force: true }))

describe('pinned skills', () => {
  it('chain the profile, the drawer and the page, once each', () => {
    const profile = Profile.parse({
      name: 'Work',
      skills: ['review', 'Deploy'],
      drawers: [
        { name: 'Game', skills: ['godot-scenes', 'review'], sections: [] },
        { name: 'Other', sections: [] },
      ],
    })
    const item: NavItem = { type: 'folder', label: 'Tuohi', path: '~/tuohi', steps: [], skills: ['concept-art', 'deploy'] }
    expect(pinnedSkills(profile, 0, item)).toEqual({ profile: ['review', 'Deploy'], drawer: ['godot-scenes', 'review'], page: ['concept-art', 'deploy'], all: ['review', 'Deploy', 'godot-scenes', 'concept-art'] })
    expect(pinnedSkills(profile, 1).all).toEqual(['review', 'Deploy'])
    // A profile without drawers: its one drawer carries the profile's list.
    expect(pinnedSkills(Profile.parse({ name: 'P', skills: ['a'], sections: [] }), 0).drawer).toEqual(['a'])
  })

  it('resolve to the wiki’s skills first, then installed ones; the rest are missing', async () => {
    await skill('concept-art', 'Prompts for concept art')
    await skill('review', 'The wiki’s own review')
    const installed = [doc('review', 'Reviews a change', 'your skill review'), doc('review', 'Reviews a change before it ships'), doc('deploy', 'Ships it')]
    const r = await resolveSkills(['concept-art', 'Review', 'deploy', 'nope', '../etc'], installed, wiki)
    expect(r.found).toEqual([
      { name: 'concept-art', description: 'Prompts for concept art', invoke: '/wiki:concept-art', dir: path.join(wiki, 'skills/concept-art') },
      { name: 'review', description: 'The wiki’s own review', invoke: '/wiki:review', dir: path.join(wiki, 'skills/review') },
      { name: 'deploy', description: 'Ships it', invoke: '/deploy' },
    ])
    expect(r.missing).toEqual(['nope', '../etc'])
    // Without a wiki, the installed one that is not overridden wins.
    expect((await resolveSkills(['review'], installed, null)).found[0]).toEqual({ name: 'review', description: 'Reviews a change before it ships', invoke: '/review' })
    expect((await wikiSkills(wiki)).map((s) => s.name)).toEqual(['concept-art', 'review'])
  })

  it('the prompt names each skill with its description', async () => {
    await skill('concept-art', 'Prompts for concept art')
    const { found } = await resolveSkills(['concept-art', 'deploy'], [doc('deploy', '')], wiki)
    expect(skillsPrompt(found)).toBe('# Pinned skills (Workbench)\n\nThese skills are pinned for the work here; use them when they fit:\n- /wiki:concept-art: Prompts for concept art\n- /deploy')
    expect(skillsPrompt([])).toBeNull()
  })

  it('a bundle links the pinned wiki skills, keyed by the set; prune keeps what chats name', async () => {
    await skill('concept-art', 'A')
    await skill('godot-scenes', 'B')
    const bundles = new SkillBundles(path.join(dir, 'state/skills'))
    const { found } = await resolveSkills(['godot-scenes', 'concept-art', 'deploy'], [doc('deploy', '')], wiki)
    const plugin = (await bundles.bundle(found))!
    expect(plugin).toMatch(/\/state\/skills\/[0-9a-f]{16}\/wiki$/)
    expect(await fsp.readlink(path.join(plugin, 'skills/concept-art'))).toBe(path.join(wiki, 'skills/concept-art'))
    expect(await fsp.readlink(path.join(plugin, 'skills/godot-scenes'))).toBe(path.join(wiki, 'skills/godot-scenes'))
    expect(JSON.parse(await fsp.readFile(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('wiki')
    // The same set (any order, installed ones aside) is the same bundle; another set is another.
    expect(await bundles.bundle((await resolveSkills(['concept-art', 'godot-scenes'], [], wiki)).found)).toBe(plugin)
    const other = (await bundles.bundle((await resolveSkills(['concept-art'], [], wiki)).found))!
    expect(other).not.toBe(plugin)
    // Only installed skills pinned: nothing to load.
    expect(await bundles.bundle((await resolveSkills(['deploy'], [doc('deploy', '')], wiki)).found)).toBeNull()

    await bundles.prune(pluginDirsIn(['--model', 'opus', '--plugin-dir', other, '--add-dir', '/x']))
    expect(await fsp.readdir(path.join(dir, 'state/skills'))).toEqual([path.basename(path.dirname(other))])
    expect(pluginDirsIn(['--plugin-dir'])).toEqual([])
  })
})
