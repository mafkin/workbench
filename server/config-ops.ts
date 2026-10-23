// Edits to a profile, applied to the parsed YAML document rather than to plain
// data, so the user's comments, key order and flow style survive app edits.
import { isMap, isNode, isScalar, isSeq, Pair, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import type { z } from 'zod'
import {
  AGENT_FIELDS,
  AGENT_NAME,
  AGENT_NAME_RULE,
  AgentProfile,
  Drawer,
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
  DRAWER_FIELDS,
  FOLDER_STEPS,
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

/** An empty `[]` list gets what is added to it as block entries, not one long `[ … ]` line. */
function blockWhenEmpty(seq: YAMLSeq): YAMLSeq {
  if (seq.flow && seq.items.length === 0) seq.flow = false
  return seq
}

/** The map's `items` sequence, created when missing or empty (`items:`). */
function itemsOf(doc: Document, map: YAMLMap): YAMLSeq {
  const node = map.get('items', true)
  if (isSeq(node)) return blockWhenEmpty(node)
  const seq = doc.createNode([]) as YAMLSeq
  map.set('items', seq)
  return seq
}

/** A drawer's headings: `drawers[d].sections`, or without `drawers:` the top-level `sections:` (drawer 0). */
function sections(doc: Document, drawer = 0): YAMLSeq {
  const drawers = doc.get('drawers', true)
  const owner = isSeq(drawers) ? drawerAt(drawers, drawer) : drawer === 0 ? doc : null
  if (!owner) throw new OpError(`Drawer ${drawer} does not exist`)
  const node = owner.get('sections', true)
  if (isSeq(node)) return blockWhenEmpty(node)
  const seq = doc.createNode([]) as YAMLSeq
  owner.set('sections', seq)
  return seq
}

function drawerAt(drawers: YAMLSeq, i: number): YAMLMap {
  const node = nth(drawers, i, 'Drawer')
  if (!isMap(node)) throw new OpError(`Drawer ${i} is not a mapping`)
  return node
}

function sectionAt(doc: Document, i: number, drawer = 0): YAMLMap {
  const node = nth(sections(doc, drawer), i, 'Heading')
  if (!isMap(node)) throw new OpError(`Heading ${i} is not a mapping`)
  return node
}

function listAt(doc: Document, addr: ListAddr): YAMLSeq {
  const seq = itemsOf(doc, sectionAt(doc, addr.section, addr.drawer))
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
  // A new item is written `type: item` and starts blank; one without a folder gets an id to be known by.
  const isNew = schema === NavItem && input.type === 'item'
  const out: Record<string, unknown> = { label: item.label, type: isNew ? 'item' : item.type }
  if (item.type === 'group') out.items = []
  for (const key of TYPE_FIELDS[item.type]) {
    if (key === 'items' || key === 'collapsed') continue
    const value = (item as Record<string, unknown>)[key]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    out[key] = value
  }
  if (item.icon) out.icon = item.icon
  if (item.id) out.id = item.id
  // Starting with a letter, an id never reads as a number (YAML would quote 12345678 or 1e234567).
  else if (isNew && !out.path) out.id = `i${crypto.randomUUID().slice(0, 7)}`
  if (isNew) out.steps = []
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
  // An item keeps the word its line has (`item`, or `folder` from before).
  node.set('type', item.type === 'folder' && (oldType === 'item' || input.type === 'item') ? 'item' : item.type)
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

/** The item at `at` (`type: item`, or `folder` as projects were written before): items have cards and steps. */
function folderAt(doc: Document, at: ItemAddr): YAMLMap {
  const node = nth(listAt(doc, at), at.index, 'Entry')
  if (!isMap(node) || (node.get('type') !== 'folder' && node.get('type') !== 'item')) throw new OpError('Only items have cards and steps')
  return node
}

/**
 * The item's own steps. The first change to an older project without `steps:`
 * writes the tabs it showed: `seed` (the service works it out, Git included
 * when its folder is a repository), else All files, Claude setup and the workflow.
 */
function ownSteps(doc: Document, at: ItemAddr, seed?: ItemInput[]): YAMLSeq {
  const node = folderAt(doc, at)
  if (node.has('steps')) {
    const steps = node.get('steps', true)
    if (isSeq(steps)) return steps
  }
  let seq: YAMLSeq
  // Steps are short: one-line `{ … }` maps, like the workflow's.
  const oneLine = (data: Record<string, unknown>) => Object.assign(doc.createNode(data) as YAMLMap, { flow: true })
  if (seed) {
    seq = doc.createNode([]) as YAMLSeq
    for (const s of seed) seq.items.push(oneLine(newItemData(s, StepItem)))
  } else {
    const workflow = doc.get('workflow', true)
    seq = isSeq(workflow) ? (workflow.clone() as YAMLSeq) : (doc.createNode([]) as YAMLSeq)
    const has = (type: string) => seq.items.some((i) => isMap(i) && i.get('type') === type)
    if (!has('setup')) seq.items.unshift(oneLine({ label: 'Claude setup', type: 'setup' }))
    if (!has('files')) seq.items.unshift(oneLine({ label: 'All files', type: 'files' }))
  }
  node.set('steps', seq)
  return seq
}

function checkStep(input: ItemInput) {
  if (!(STEP_TYPES as readonly string[]).includes(input.type)) throw new OpError('A step is a file browser, folder, note, Git, Claude setup, report, file, chat, launcher or link')
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

/** Set a top-level key, adding it just before `drawers` or `sections` when it is new. */
function setTopLevel(doc: Document, key: string, value: unknown) {
  const map = doc.contents
  if (!isMap(map)) throw new OpError('The profile is not a mapping')
  if (map.has(key)) {
    map.set(key, value)
    return
  }
  const at = map.items.findIndex((pair) => {
    const k = isScalar(pair.key) ? pair.key.value : pair.key
    return k === 'sections' || k === 'drawers'
  })
  map.items.splice(at < 0 ? map.items.length : at, 0, doc.createPair(key, value))
}

/** Set a top-level profile key in place; a new key goes after the keys that precede it in PROFILE_FIELDS. */
function setProfileField(doc: Document, key: (typeof PROFILE_FIELDS)[number], raw: string) {
  const map = doc.contents
  if (!isMap(map)) throw new OpError('The profile is not a mapping')
  const value = raw.trim()
  if (!value && key !== 'name' && key !== 'accent') {
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
  for (const { seq } of entryLists(doc)) {
    for (const item of seq.items) {
      if (!isMap(item)) continue
      const label = String(item.get('label'))
      check(item, label)
      const steps = item.get('steps', true)
      if (isSeq(steps)) for (const step of steps.items) check(step, `${label} › ${isMap(step) ? step.get('label') : '?'}`)
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

// Drawers

/**
 * The profile's `drawers:`. The first drawer change to a profile without it
 * moves its `sections:` (with their comments) into a first drawer named after
 * the profile, in the same place in the file.
 */
function ownDrawers(doc: Document): YAMLSeq {
  const existing = doc.get('drawers', true)
  if (isSeq(existing)) return existing
  const map = doc.contents
  if (!isMap(map)) throw new OpError('The profile is not a mapping')
  const first = doc.createNode({ name: String(doc.get('name') ?? 'Main') }) as YAMLMap
  const seq = doc.createNode([]) as YAMLSeq
  seq.items.push(first)
  const at = map.items.findIndex((pair) => keyOf(pair) === 'sections')
  if (at < 0) {
    first.set('sections', doc.createNode([]))
    map.items.push(doc.createPair('drawers', seq))
  } else {
    const pair = map.items[at]
    first.items.push(new Pair(pair.key, isSeq(pair.value) ? pair.value : doc.createNode([])))
    map.items[at] = doc.createPair('drawers', seq) as (typeof map.items)[number]
  }
  return seq
}

/** A drawer's name: its `name:`, or the profile's for the one drawer of a profile without `drawers:`. */
function drawerName(doc: Document, drawer = 0): string {
  const drawers = doc.get('drawers', true)
  return String(isSeq(drawers) ? drawerAt(drawers, drawer).get('name') : doc.get('name'))
}

function drawerLabel(value: string): string {
  const parsed = Drawer.shape.name.safeParse(value)
  if (!parsed.success) throw new OpError(parsed.error.issues[0]?.message ?? 'Invalid drawer name')
  return parsed.data
}

function checkFreeName(drawers: YAMLSeq, name: string, except?: unknown) {
  if (drawers.items.some((d) => d !== except && isMap(d) && sameName(d.get('name'), name))) throw new OpError(`There is already a drawer called ${name}`)
}

/** Every entry list of every drawer (headings and groups), with the drawer's index. */
function entryLists(doc: Document): { drawer: number; seq: YAMLSeq }[] {
  const out: { drawer: number; seq: YAMLSeq }[] = []
  const drawers = doc.get('drawers', true)
  const owners = isSeq(drawers) ? drawers.items : [doc.contents]
  owners.forEach((owner, drawer) => {
    const secs = isMap(owner) ? owner.get('sections', true) : null
    if (!isSeq(secs)) return
    for (const section of secs.items) {
      const items = isMap(section) ? section.get('items', true) : null
      if (!isSeq(items)) continue
      out.push({ drawer, seq: items })
      for (const item of items.items) {
        const children = isMap(item) && item.get('type') === 'group' ? item.get('items', true) : null
        if (isSeq(children)) out.push({ drawer, seq: children })
      }
    }
  })
  return out
}

/** What a shared entry matches: the original's drawer name, label and path. */
interface Original {
  drawer: string
  label: string
  path?: string
}

const originalOf = (doc: Document, drawer: number, node: YAMLMap): Original => ({
  drawer: drawerName(doc, drawer),
  label: String(node.get('label')),
  path: typeof node.get('path') === 'string' ? String(node.get('path')) : undefined,
})

function pointsAt(node: unknown, o: Original): node is YAMLMap {
  if (!isMap(node) || node.get('type') !== 'shared' || !sameName(node.get('drawer'), o.drawer) || node.get('label') !== o.label) return false
  const path = node.get('path')
  return path === undefined || path === o.path
}

/** Remove the shared entries that point at `o` (in one drawer, or all); returns how many went. */
function dropShared(doc: Document, o: Original, onlyDrawer?: number): number {
  let n = 0
  for (const { drawer, seq } of entryLists(doc)) {
    if (onlyDrawer !== undefined && drawer !== onlyDrawer) continue
    const before = seq.items.length
    seq.items = seq.items.filter((item) => !pointsAt(item, o))
    n += before - seq.items.length
  }
  return n
}

/** Shared entries follow their original's new label and path. */
function followShared(doc: Document, was: Original, now: Original) {
  if (was.label === now.label && was.path === now.path) return
  for (const { seq } of entryLists(doc)) {
    for (const item of seq.items) {
      if (!pointsAt(item, was)) continue
      item.set('label', now.label)
      if (item.has('path')) {
        if (now.path === undefined) item.delete('path')
        else item.set('path', now.path)
      }
    }
  }
}

/** The originals inside an entry: itself, or a group's children. */
function originalsIn(doc: Document, drawer: number, node: unknown): Original[] {
  if (!isMap(node) || node.get('type') === 'shared') return []
  if (node.get('type') !== 'group') return [originalOf(doc, drawer, node)]
  const children = node.get('items', true)
  return isSeq(children) ? children.items.flatMap((child) => originalsIn(doc, drawer, child)) : []
}

function setDrawer(doc: Document, index: number, field: (typeof DRAWER_FIELDS)[number], value: string | string[]) {
  const drawers = ownDrawers(doc)
  const node = drawerAt(drawers, index)
  if (field === 'name') {
    if (typeof value !== 'string') throw new OpError('A drawer name is text')
    const name = drawerLabel(value)
    const old = String(node.get('name'))
    if (name === old) return
    checkFreeName(drawers, name, node)
    node.set('name', name)
    // Shared entries and `uses:` name drawers; they follow the rename.
    for (const { seq } of entryLists(doc)) for (const item of seq.items) if (isMap(item) && item.get('type') === 'shared' && sameName(item.get('drawer'), old)) item.set('drawer', name)
    for (const d of drawers.items) {
      const uses = isMap(d) ? d.get('uses', true) : null
      if (isSeq(uses)) for (const u of uses.items) if (isScalar(u) && sameName(u.value, old)) u.value = name
    }
    return
  }
  if (field === 'uses') {
    const names = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean)
    if (!names.length) {
      node.delete('uses')
      return
    }
    const seq = doc.createNode(names) as YAMLSeq
    seq.flow = true
    setDrawerKey(doc, node, 'uses', seq)
    return
  }
  if (typeof value !== 'string') throw new OpError(`A drawer's ${field} is text`)
  const v = value.trim()
  if (!v) node.delete(field)
  else setDrawerKey(doc, node, field, v)
}

/** Set a drawer key in place; a new one goes before `sections:`, so the drawer's settings read first. */
function setDrawerKey(doc: Document, node: YAMLMap, key: string, value: unknown) {
  if (node.has(key) || !node.has('sections')) {
    node.set(key, value)
    return
  }
  const at = node.items.findIndex((pair) => keyOf(pair) === 'sections')
  node.items.splice(at, 0, doc.createPair(key, value))
}

function deleteDrawer(doc: Document, index: number) {
  const drawers = ownDrawers(doc)
  drawerAt(drawers, index)
  if (drawers.items.length <= 1) throw new OpError('A profile keeps at least one drawer')
  const name = drawerName(doc, index)
  drawers.items.splice(index, 1)
  for (const { seq } of entryLists(doc)) seq.items = seq.items.filter((item) => !(isMap(item) && item.get('type') === 'shared' && sameName(item.get('drawer'), name)))
  for (const d of drawers.items) {
    const uses = isMap(d) ? d.get('uses', true) : null
    if (!isSeq(uses)) continue
    uses.items = uses.items.filter((u) => !(isScalar(u) && sameName(u.value, name)))
    if (!uses.items.length) (d as YAMLMap).delete('uses')
  }
}

/** Show the entry at `at` in another drawer, under a heading of the same title (added when missing), or stop showing it there. */
function setShared(doc: Document, at: ItemAddr, target: number, on: boolean) {
  const home = at.drawer ?? 0
  const node = nth(listAt(doc, at), at.index, 'Entry')
  if (!isMap(node)) throw new OpError(`Entry ${at.index} is not a mapping`)
  const type = node.get('type')
  if (type === 'group') throw new OpError('Groups are not shared; share the entries inside')
  if (type === 'shared') throw new OpError('This entry is already shared from another drawer')
  if (target === home) throw new OpError('The entry is already in this drawer')
  const original = originalOf(doc, home, node)
  const secs = sections(doc, target)
  if (!on) {
    dropShared(doc, original, target)
    return
  }
  if (entryLists(doc).some(({ drawer, seq }) => drawer === target && seq.items.some((item) => pointsAt(item, original)))) return
  const heading = String(sectionAt(doc, at.section, home).get('title'))
  let section = secs.items.find((sec) => isMap(sec) && sameName(sec.get('title'), heading)) as YAMLMap | undefined
  if (!section) {
    section = doc.createNode({ title: heading, items: [] }) as YAMLMap
    secs.items.push(section)
  }
  const ref: Record<string, string> = { label: original.label, type: 'shared', drawer: original.drawer }
  if (original.path !== undefined) ref.path = original.path
  itemsOf(doc, section).items.push(doc.createNode(ref))
}

function applyOp(doc: Document, op: Op) {
  switch (op.op) {
    case 'addSection': {
      const seq = sections(doc, op.drawer)
      seq.items.splice(clamp(op.index, seq.items.length), 0, doc.createNode({ title: title(op.title), items: [] }))
      return
    }
    case 'renameSection':
      sectionAt(doc, op.section, op.drawer).set('title', title(op.title))
      return
    case 'deleteSection': {
      const seq = sections(doc, op.drawer)
      const node = nth(seq, op.section, 'Heading')
      seq.items.splice(op.section, 1)
      const items = isMap(node) ? node.get('items', true) : null
      if (isSeq(items)) for (const item of items.items) for (const o of originalsIn(doc, op.drawer ?? 0, item)) dropShared(doc, o)
      return
    }
    case 'moveSection': {
      const seq = sections(doc, op.drawer)
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
      const was = node.get('type') === 'shared' || node.get('type') === 'group' ? null : originalOf(doc, op.at.drawer ?? 0, node)
      updateItemNode(doc, node, op.item)
      if (was) followShared(doc, was, originalOf(doc, op.at.drawer ?? 0, node))
      return
    }
    case 'deleteItem': {
      const seq = listAt(doc, op.at)
      const node = nth(seq, op.at.index, 'Entry')
      seq.items.splice(op.at.index, 1)
      // What other drawers show of it goes too.
      for (const o of originalsIn(doc, op.at.drawer ?? 0, node)) dropShared(doc, o)
      return
    }
    case 'moveItem': {
      if ((op.from.drawer ?? 0) !== (op.to.drawer ?? 0)) throw new OpError('Entries move within their drawer; use Show in drawers to show one in another')
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
      if ((FOLDER_STEPS as readonly string[]).includes(op.step.type)) {
        const item = folderAt(doc, op.at)
        if (!item.get('path')) {
          if (!op.folder) throw new OpError('This item has no folder yet: choose one first')
          // Give the item its folder, after its type, where a path is written.
          const at = item.items.findIndex((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === 'type')
          item.items.splice(at + 1, 0, doc.createPair('path', op.folder))
        }
      }
      const seq = ownSteps(doc, op.at, op.seed)
      const node = doc.createNode(newItemData(op.step, StepItem)) as YAMLMap
      // Match the list: steps written as one-line { … } maps get a new one the same way.
      node.flow = seq.items.length > 0 && seq.items.every((i) => isMap(i) && i.flow)
      seq.items.splice(clamp(op.index, seq.items.length), 0, node)
      return
    }
    case 'updateStep': {
      checkStep(op.step)
      const node = nth(ownSteps(doc, op.at, op.seed), op.index, 'Step')
      if (!isMap(node)) throw new OpError(`Step ${op.index} is not a mapping`)
      updateItemNode(doc, node, op.step, StepItem)
      return
    }
    case 'deleteStep': {
      const seq = ownSteps(doc, op.at, op.seed)
      nth(seq, op.index, 'Step')
      seq.items.splice(op.index, 1)
      return
    }
    case 'moveStep': {
      const seq = ownSteps(doc, op.at, op.seed)
      nth(seq, op.from, 'Step')
      const [node] = seq.items.splice(op.from, 1)
      seq.items.splice(clamp(op.to, seq.items.length), 0, node)
      return
    }
    case 'addWorkflow': {
      const seq = ownSteps(doc, op.at, op.seed)
      const workflow = doc.get('workflow', true)
      if (!isSeq(workflow)) return
      const key = (i: unknown) => (isMap(i) ? `${String(i.get('type'))}|${String(i.get('label'))}` : '')
      const has = new Set(seq.items.map(key))
      for (const step of workflow.items) if (!has.has(key(step))) seq.items.push((step as YAMLMap).clone() as YAMLMap)
      return
    }
    case 'setWorkflow':
      setTopLevel(doc, 'workflow', ownSteps(doc, op.at, op.seed).clone())
      return
    case 'setCategory': {
      const existing = doc.get('categories', true)
      if (op.color === null) {
        if (!isMap(existing)) return
        existing.delete(op.name)
        if (existing.items.length === 0) doc.delete('categories')
      } else if (isMap(existing)) existing.set(op.name, op.color)
      else setTopLevel(doc, 'categories', doc.createNode({ [op.name]: op.color }))
      return
    }
    case 'setMcpOff': {
      const existing = doc.get('mcpOff', true)
      if (!isSeq(existing)) {
        if (op.off) setTopLevel(doc, 'mcpOff', doc.createNode(op.names))
        return
      }
      const has = existing.items.map((n) => (isScalar(n) ? n.value : n))
      if (op.off) {
        for (const name of op.names) if (!has.includes(name)) existing.add(doc.createNode(name))
      } else {
        for (let i = existing.items.length - 1; i >= 0; i--) if (op.names.includes(has[i] as string)) existing.items.splice(i, 1)
      }
      if (existing.items.length === 0) doc.delete('mcpOff')
      return
    }
    case 'setAgent':
      setAgent(doc, op.name, op.agent, op.rename)
      return
    case 'setCard':
      setCard(doc, folderAt(doc, op.at), op.field, op.value)
      return
    case 'addDrawer': {
      const drawers = ownDrawers(doc)
      const name = drawerLabel(op.name)
      checkFreeName(drawers, name)
      drawers.items.push(doc.createNode({ name, sections: [] }))
      return
    }
    case 'setDrawer':
      setDrawer(doc, op.drawer, op.field, op.value)
      return
    case 'deleteDrawer':
      deleteDrawer(doc, op.drawer)
      return
    case 'setShared':
      setShared(doc, op.at, op.drawer, op.on)
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
