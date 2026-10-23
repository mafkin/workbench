import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { agentArgs, claudeAgents } from '../server/agents.ts'
import { agentSummary, AgentProfile, chatProgram, findAgent, NavItem, Profile } from '../shared/config-schema.ts'

const SOURCE = `# Work
name: Work
workflow:
  - { label: review, type: chat, agent: Reviewer }
# How each agent works
agents:
  Reviewer: # reads, never writes
    model: opus
    permission: plan
  Scratch:
sections:
  - title: Projects
    items:
      - label: Alpha
        type: folder
        path: ~/alpha
        agent: Reviewer
      - { label: Notes, type: chat, agent: reviewer }
`

const ALL = AgentProfile.parse({})

describe('agent profiles in the schema', () => {
  it('reads profiles by name; an empty one is allowed', () => {
    const p = Profile.parse(parseDocument(SOURCE).toJS())
    expect(Object.keys(p.agents ?? {})).toEqual(['Reviewer', 'Scratch'])
    expect(p.agents?.Scratch).toEqual(ALL)
    expect(findAgent(p, 'reviewer')?.[0]).toBe('Reviewer')
    expect(findAgent(p, 'nobody')).toBeNull()
  })

  it('refuses reserved, odd or duplicate names and unknown modes', () => {
    const with_ = (agents: object) => Profile.safeParse({ name: 'W', sections: [], agents }).success
    expect(with_({ Claude: {} })).toBe(false)
    expect(with_({ shell: {} })).toBe(false)
    expect(with_({ 'a/b': {} })).toBe(false)
    expect(with_({ Rev: {}, rev: {} })).toBe(false)
    expect(with_({ Rev: { permission: 'yolo' } })).toBe(false)
    expect(with_({ Rev: { effort: 'huge' } })).toBe(false)
    expect(with_({ 'Game dev': { permission: 'bypassPermissions', effort: 'xhigh' } })).toBe(true)
  })

  it('a chat names claude, shell or an agent profile; the program follows', () => {
    expect(NavItem.parse({ label: 'R', type: 'chat', agent: 'Reviewer' })).toMatchObject({ agent: 'Reviewer' })
    expect(chatProgram('shell')).toBe('shell')
    expect(chatProgram('Reviewer')).toBe('claude')
    expect(chatProgram(undefined)).toBe('claude')
  })

  it('summarizes a profile for menus', () => {
    expect(agentSummary({ ...ALL, model: 'opus', effort: 'high', permission: 'plan' })).toBe('opus · high · plan')
    expect(agentSummary({ ...ALL, agent: 'orchestrator', model: 'opus', permission: 'bypassPermissions' })).toBe('agent orchestrator · bypass')
    expect(agentSummary(ALL)).toBe('')
  })
})

describe('agent profile flags', () => {
  const home = '/home/u'
  const cwd = '/home/u/alpha'

  it('turns each field into claude flags; variadic lists come last, so nothing can swallow the prompt', () => {
    const p = AgentProfile.parse({
      model: 'opus',
      effort: 'high',
      permission: 'acceptEdits',
      instructions: '  Review only.  ',
      prompt: 'Start with the parser',
      folders: ['~/shared', 'docs', '/opt/x'],
      allowedTools: ['Read', 'Bash(git:*)'],
      disallowedTools: ['Write'],
      mcp: '~/mcp/review.json',
    })
    expect(agentArgs(p, home, cwd)).toEqual({
      args: [
        '--model', 'opus',
        '--effort', 'high',
        '--permission-mode', 'acceptEdits',
        '--append-system-prompt', 'Review only.',
        '--mcp-config', '/home/u/mcp/review.json',
        '--add-dir', '/home/u/shared', '/home/u/alpha/docs', '/opt/x',
        '--allowedTools', 'Read', 'Bash(git:*)',
        '--disallowedTools', 'Write',
      ],
      prompt: 'Start with the parser',
      bypass: false,
    })
  })

  it('context folders and text merge into one --add-dir and one --append-system-prompt', () => {
    const context = { prompt: 'Your context lives in ~/notes/context.', dirs: ['/home/u/notes/context', '/home/u/notes/inbox'] }
    const p = AgentProfile.parse({ model: 'opus', instructions: 'Review only.', folders: ['~/shared'], allowedTools: ['Read'] })
    expect(agentArgs(p, home, cwd, context).args).toEqual([
      '--model', 'opus',
      '--append-system-prompt', 'Review only.\n\nYour context lives in ~/notes/context.',
      '--add-dir', '/home/u/shared', '/home/u/notes/context', '/home/u/notes/inbox',
      '--allowedTools', 'Read',
    ])
    // Plain claude: just the context.
    expect(agentArgs(AgentProfile.parse({}), home, cwd, context).args).toEqual([
      '--append-system-prompt', 'Your context lives in ~/notes/context.',
      '--add-dir', '/home/u/notes/context', '/home/u/notes/inbox',
    ])
  })

  it('a Claude agent decides the model and effort', () => {
    const p = AgentProfile.parse({ agent: 'orchestrator', model: 'opus', effort: 'max', permission: 'bypassPermissions' })
    expect(agentArgs(p, home, cwd)).toEqual({ args: ['--agent', 'orchestrator', '--permission-mode', 'bypassPermissions'], prompt: undefined, bypass: true })
  })
})

describe('Claude agents', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-agents-')))
    await fsp.mkdir(path.join(dir, 'home/.claude/agents'), { recursive: true })
    await fsp.mkdir(path.join(dir, 'proj/.claude/agents'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'home/.claude/agents/orch.md'), '---\nname: orchestrator\ndescription: x\n---\nYou coordinate.\n')
    await fsp.writeFile(path.join(dir, 'home/.claude/agents/plain.md'), 'No front matter\n')
    await fsp.writeFile(path.join(dir, 'proj/.claude/agents/tester.md'), '---\nname: "tester"\n---\n')
    await fsp.writeFile(path.join(dir, 'proj/.claude/agents/notes.txt'), 'not an agent')
  })

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it("lists your agents and the project's, by their front matter name", async () => {
    expect(await claudeAgents(path.join(dir, 'home'), path.join(dir, 'proj'))).toEqual(['orchestrator', 'plain', 'tester'])
    expect(await claudeAgents(path.join(dir, 'nowhere'), path.join(dir, 'nowhere'))).toEqual([])
  })
})
