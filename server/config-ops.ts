// Edits to a profile, applied to the parsed YAML document rather than to plain
// data, so the user's comments, key order and flow style survive app edits.
import { isMap, isNode, isScalar, isSeq, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import type { z } from 'zod'
import {
  AGENT_FIELDS,
  AGENT_NAME,
  AGENT_NAME_RULE,
  AgentProfile,
  isReservedAgent,
  NavItem,
  Profile,
  PROFILE_FIELDS,
  StepItem,
  STEP_TYPES,
  TYPE_FIELDS,
  type ItemAddr,
  type ItemInput,
  type ListAddr,
  type Op,
} from '../shared/config-schema.ts'

export class OpError extends Error {}

export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid value'
  const path = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '')
  return path ? `${path}: ${issue.message}` : issue.message
}

function nth(seq: YAMLSeq, i: number, what: string): unknown {
  if (!Number.isInteger(i) || i < 0 || i >= seq.items.length) throw new OpError(`${what} ${i} does not exist`)
  return seq.items[i]
}

function clamp(i: number | undefined, len: number): number {
  if (i === undefined || !Number.isInteger(i)) return len
  return Math.max(0, Math.min(i, len))
}

/** The map's `items` sequence, created when missing or empty (`items:`). */
function itemsOf(doc: Document, map: YAMLMap): YAMLSeq {
  const node = map.get('items', true)
  if (isSeq(node)) return node
  const seq = doc.createNode([]) as YAMLSeq
  map.set('items', seq)
  return seq
}

function sections(doc: Document): YAMLSeq {
  const node = doc.get('sections', true)
  if (isSeq(node)) return node
  const seq = doc.createNode([]) as YAMLSeq
  doc.set('sections', seq)
  return seq
}

function sectionAt(doc: Document, i: number): YAMLMap {
  const node = nth(sections(doc), i, 'Heading')
  if (!isMap(node)) throw new OpError(`Heading ${i} is not a mapping`)
  return node
}

function listAt(doc: Document, addr: ListAddr): YAMLSeq {
  const seq = itemsOf(doc, sectionAt(doc, addr.section))
  if (addr.group === undefined) return seq
  const group = nth(seq, addr.group, 'Group')
  if (!isMap(group) || group.get('type') !== 'group') throw new OpError(`Entry ${addr.group} is not a group`)
  return itemsOf(doc, group)
}

/** A nav entry, or with `StepItem`, a workflow step. */
function parseItem(input: ItemInput, schema: typeof NavItem | typeof StepItem = NavItem) {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new OpError(describeIssue(parsed.error))
  return parsed.data
}

function title(value: string): string {
  const t = value.trim()
  if (!t) throw new OpError('Heading title is required')
  return t
}

/** Plain object for a new item, in a readable key order, without empty fields. */
function newItemData(input: ItemInput, schema: typeof NavItem | typeof StepItem = NavItem): Record<string, unknown> {
  const item = parseItem(input, schema)
  const out: Record<string, unknown> = { label: item.label, type: item.type }
  if (item.type === 'group') out.items = []
  for (const key of TYPE_FIELDS[item.type]) {
    if (key === 'items' || key === 'collapsed') continue
    const value = (item as Record<string, unknown>)[key]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    out[key] = value
  }
  if (item.icon) out.icon = item.icon
  if (item.id) out.id = item.id
  return out
}

function updateItemNode(doc: Document, node: YAMLMap, input: ItemInput, schema: typeof NavItem | typeof StepItem = NavItem) {
  const item = parseItem(input, schema)
  const oldType = node.get('type')
  if (oldType === 'group' && item.type !== 'group') {
    const children = node.get('items', true)
    if (isSeq(children) && children.items.length > 0) {
      throw new OpError('Move or delete the entries in this group before changing its type')
    }
  }
  node.set('label', item.label)
  node.set('type', item.type)
  // Clear fields owned by other types; keep id and any keys the app does not manage.
  for (const [type, keys] of Object.entries(TYPE_FIELDS)) {
    if (type === item.type) continue
    for (const key of keys) node.delete(key)
  }
  if (item.type === 'group') {
    itemsOf(doc, node)
  } else {
    for (const key of TYPE_FIELDS[item.type]) {
      const value = (item as Record<string, unknown>)[key]
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) node.delete(key)
      else node.set(key, Array.isArray(value) ? doc.createNode(value) : value)
    }
  }
  if (item.icon) node.set('icon', item.icon)
  else node.delete('icon')
}

/** The folder entry at `at`: projects, with cards and steps, are folder entries. */
function folderAt(doc: Document, at: ItemAddr): YAMLMap {
  const node = nth(listAt(doc, at), at.index, 'Entry')
  if (!isMap(node) || node.get('type') !== 'folder') throw new OpError('Only folder entries are projects')
  return node
}

/** The project's own steps. The first change to a project using the profile's workflow copies it in. */
function ownSteps(doc: Document, at: ItemAddr): YAMLSeq {
  const node = folderAt(doc, at)
  if (node.has('steps')) {
    const steps = node.get('steps', true)
    if (isSeq(steps)) return steps
  }
  const workflow = doc.get('workflow', true)
  const seq = isSeq(workflow) ? (workflow.clone() as YAMLSeq) : (doc.createNode([]) as YAMLSeq)
  node.set('steps', seq)
  return seq
}

function checkStep(input: ItemInput) {
  if (!(STEP_TYPES as readonly string[]).includes(input.type)) throw new OpError('A step is a folder, note, report, file, launcher or link')
}

/** Set a card field; a new one goes before `steps:`, so the card reads first. Null or an empty string removes it. */
function setCard(doc: Document, node: YAMLMap, field: string, raw: string | boolean | null) {
  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value === null || value === '') {
    node.delete(field)
    return
  }
  if (node.has(field) || !node.has('steps')) {
    node.set(field, value)
    return
  }
  const at = node.items.findIndex((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === 'steps')
  node.items.splice(at, 0, doc.createPair(field, value))
}

/** Set a top-level key, adding it just before `sections` when it is new. */
function setTopLevel(doc: Document, key: string, value: unknown) {
  const map = doc.contents
  if (!isMap(map)) throw new OpError('The profile is not a mapping')
  if (map.has(key)) {
    map.set(key, value)
    return
  }
  const at = map.items.findIndex((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === 'sections')
  map.items.splice(at < 0 ? map.items.length : at, 0, doc.createPair(key, value))
}

/** Set a top-level profile key in place; a new key goes after the keys that precede it in PROFILE_FIELDS. */
function setProfileField(doc: Document, key: (typeof PROFILE_FIELDS)[number], raw: string) {
  const map = doc.contents
  if (!isMap(map)) throw new OpError('The profile is not a mapping')
  const value = raw.trim()
  if (!value && (key === 'home' || key === 'notes')) {
    map.delete(key)
    return
  }
  if (map.has(key)) {
    map.set(key, value)
    return
  }
  const before = new Set<unknown>(PROFILE_FIELDS.slice(0, PROFILE_FIELDS.indexOf(key)))
  const keyOf = (pair: (typeof map.items)[number]) => (isScalar(pair.key) ? pair.key.value : pair.key)
  const after = map.items.findLastIndex((pair) => before.has(keyOf(pair)))
  map.items.splice(after + 1, 0, doc.createPair(key, value))
}

const keyOf = (pair: { key: unknown }) => (isScalar(pair.key) ? pair.key.value : pair.key)
const sameName = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Entries and steps whose `agent:` names an agent profile, with where they are, for messages. */
function agentUsers(doc: Document, name: string): { node: YAMLMap; where: string }[] {
  const out: { node: YAMLMap; where: string }[] = []
  const check = (node: unknown, where: string) => {
    if (isMap(node) && sameName(node.get('agent'), name)) out.push({ node, where })
  }
  const workflow = doc.get('workflow', true)
  if (isSeq(workflow)) for (const step of workflow.items) check(step, `workflow › ${isMap(step) ? step.get('label') : '?'}`)
  const visit = (item: unknown) => {
    if (!isMap(item)) return
    const label = String(item.get('label'))
    check(item, label)
    const steps = item.get('steps', true)
    if (isSeq(steps)) for (const step of steps.items) check(step, `${label} › ${isMap(step) ? step.get('label') : '?'}`)
    const children = item.get('items', true)
    if (item.get('type') === 'group' && isSeq(children)) children.items.forEach(visit)
  }
  const secs = doc.get('sections', true)
  if (isSeq(secs)) {
    for (const section of secs.items) {
      const items = isMap(section) ? section.get('items', true) : null
      if (isSeq(items)) items.items.forEach(visit)
    }
  }
  return out
}

/**
 * Create, update, rename or delete an agent profile under `agents:`. Fields are
 * set in place, so comments and keys the app does not manage stay; a rename
 * keeps the profile's place and updates everything that names it.
 */
function setAgent(doc: Document, name: string, input: unknown, rename?: string) {
  const existing = doc.get('agents', true)
  const agents = isMap(existing) ? existing : null
  const pair = agents?.items.find((p) => sameName(keyOf(p), name))

  if (input === null) {
    if (!agents || !pair) throw new OpError(`No agent profile named ${name}`)
    const users = agentUsers(doc, name)
    if (users.length) throw new OpError(`${name} is used by ${users.map((u) => u.where).join(', ')}; pick another agent there first`)
    agents.items.splice(agents.items.indexOf(pair), 1)
    if (agents.items.length === 0) doc.delete('agents')
    return
  }

  // An empty field from the editor means "not set".
  const given = Object.entries(input as Record<string, unknown>).flatMap(([k, v]): [string, unknown][] => {
    if (typeof v === 'string') return v.trim() ? [[k, v]] : []
    if (Array.isArray(v)) {
      const items = v.filter((x) => typeof x !== 'string' || x.trim())
      return items.length ? [[k, items]] : []
    }
    return [[k, v]]
  })
  const parsed = AgentProfile.safeParse(Object.fromEntries(given))
  if (!parsed.success) throw new OpError(describeIssue(parsed.error))
  const target = (rename ?? (pair ? String(keyOf(pair)) : name)).trim()
  if (isReservedAgent(target)) throw new OpError('claude and shell are built in; pick another name')
  if (!AGENT_NAME.test(target)) throw new OpError(AGENT_NAME_RULE)
  if (agents?.items.some((p) => p !== pair && sameName(keyOf(p), target))) throw new OpError(`There is already an agent profile named ${target}`)

  let node: YAMLMap
  if (pair) {
    const old = String(keyOf(pair))
    if (target !== old) {
      if (isScalar(pair.key)) pair.key.value = target
      else pair.key = doc.createNode(target)
      for (const user of agentUsers(doc, old)) user.node.set('agent', target)
    }
    if (!isMap(pair.value)) pair.value = doc.createNode({})
    node = pair.value as YAMLMap
  } else {
    node = doc.createNode({}) as YAMLMap
    if (agents) agents.items.push(doc.createPair(target, node))
    else setTopLevel(doc, 'agents', doc.createNode({ [target]: node }))
  }
  const data = parsed.data as Record<string, unknown>
  for (const key of AGENT_FIELDS) {
    const value = data[key]
    const empty = value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0)
    if (empty) node.delete(key)
    else node.set(key, Array.isArray(value) ? doc.createNode(value) : value)
  }
}

function applyOp(doc: Document, op: Op) {
  switch (op.op) {
    case 'addSection': {
      const seq = sections(doc)
      seq.items.splice(clamp(op.index, seq.items.length), 0, doc.createNode({ title: title(op.title), items: [] }))
      return
    }
    case 'renameSection':
      sectionAt(doc, op.section).set('title', title(op.title))
      return
    case 'deleteSection': {
      const seq = sections(doc)
      nth(seq, op.section, 'Heading')
      seq.items.splice(op.section, 1)
      return
    }
    case 'moveSection': {
      const seq = sections(doc)
      nth(seq, op.from, 'Heading')
      const [node] = seq.items.splice(op.from, 1)
      seq.items.splice(clamp(op.to, seq.items.length), 0, node)
      return
    }
    case 'addItem': {
      if (op.to.group !== undefined && op.item.type === 'group') throw new OpError('A group cannot contain another group')
      const seq = listAt(doc, op.to)
      seq.items.splice(clamp(op.index, seq.items.length), 0, doc.createNode(newItemData(op.item)))
      return
    }
    case 'updateItem': {
      if (op.at.group !== undefined && op.item.type === 'group') throw new OpError('A group cannot contain another group')
      const node = nth(listAt(doc, op.at), op.at.index, 'Entry')
      if (!isMap(node)) throw new OpError(`Entry ${op.at.index} is not a mapping`)
      updateItemNode(doc, node, op.item)
      return
    }
    case 'deleteItem': {
      const seq = listAt(doc, op.at)
      nth(seq, op.at.index, 'Entry')
      seq.items.splice(op.at.index, 1)
      return
    }
    case 'moveItem': {
      const source = listAt(doc, op.from)
      const node = nth(source, op.from.index, 'Entry')
      if (op.to.group !== undefined && isMap(node) && node.get('type') === 'group') {
        throw new OpError('A group cannot contain another group')
      }
      // Resolve the target before removing, so indexes refer to the same state.
      const target = listAt(doc, op.to)
      source.items.splice(op.from.index, 1)
      target.items.splice(clamp(op.index, target.items.length), 0, node)
      return
    }
    case 'setProfileField':
      setProfileField(doc, op.key, op.value)
      return
    case 'addStep': {
      checkStep(op.step)
      const seq = ownSteps(doc, op.at)
      const node = doc.createNode(newItemData(op.step, StepItem)) as YAMLMap
      // Match the list: steps written as one-line { … } maps get a new one the same way.
      node.flow = seq.items.length > 0 && seq.items.every((i) => isMap(i) && i.flow)
      seq.items.splice(clamp(op.index, seq.items.length), 0, node)
      return
    }
    case 'updateStep': {
      checkStep(op.step)
      const node = nth(ownSteps(doc, op.at), op.index, 'Step')
      if (!isMap(node)) throw new OpError(`Step ${op.index} is not a mapping`)
      updateItemNode(doc, node, op.step, StepItem)
      return
    }
    case 'deleteStep': {
      const seq = ownSteps(doc, op.at)
      nth(seq, op.index, 'Step')
      seq.items.splice(op.index, 1)
      return
    }
    case 'moveStep': {
      const seq = ownSteps(doc, op.at)
      nth(seq, op.from, 'Step')
      const [node] = seq.items.splice(op.from, 1)
      seq.items.splice(clamp(op.to, seq.items.length), 0, node)
      return
    }
    case 'resetSteps':
      folderAt(doc, op.at).delete('steps')
      return
    case 'setWorkflow': {
      const node = folderAt(doc, op.at)
      setTopLevel(doc, 'workflow', ownSteps(doc, op.at).clone())
      node.delete('steps')
      return
    }
    case 'setAgent':
      setAgent(doc, op.name, op.agent, op.rename)
      return
    case 'setCard':
      setCard(doc, folderAt(doc, op.at), op.field, op.value)
      return
  }
}

/**
 * The parser stores a comment above a list's first entry on the list itself.
 * Move it onto the entry so it travels with the entry when that is moved;
 * the output is unchanged.
 */
function attachLeadingComments(doc: Document) {
  visit(doc, {
    Seq(_key, seq) {
      const first = seq.items[0]
      if (seq.flow || !seq.commentBefore || !isNode(first)) return
      first.commentBefore = first.commentBefore ? `${seq.commentBefore}\n${first.commentBefore}` : seq.commentBefore
      seq.commentBefore = undefined
    },
  })
}

/**
 * `name: # comment` before a block map or list parses as a comment on the
 * value, which prints on the next line. Put it back on the key's line when the
 * source has it there.
 */
function keepKeyLineComments(doc: Document, source: string) {
  visit(doc, {
    Pair(_key, pair) {
      const value = pair.value
      if (!isScalar(pair.key) || pair.key.comment || !(isMap(value) || isSeq(value)) || value.flow || !value.commentBefore) return
      const end = pair.key.range?.[1]
      if (end === undefined) return
      const hash = source.indexOf('#', end)
      if (hash < 0 || source.slice(end, hash).includes('\n')) return
      const [first, ...rest] = value.commentBefore.split('\n')
      pair.key.comment = first
      value.commentBefore = rest.length ? rest.join('\n') : undefined
    },
  })
}

/**
 * Apply ops in order; throws OpError if any op fails or the result is not a
 * valid profile. With the source text, comments on a key's line stay there.
 */
export function applyOps(doc: Document, ops: Op[], source?: string): void {
  if (source !== undefined) keepKeyLineComments(doc, source)
  attachLeadingComments(doc)
  for (const op of ops) applyOp(doc, op)
  const result = Profile.safeParse(doc.toJS())
  if (!result.success) throw new OpError(describeIssue(result.error))
}
