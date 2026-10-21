// Edits to a profile, applied to the parsed YAML document rather than to plain
// data, so the user's comments, key order and flow style survive app edits.
import { isMap, isNode, isSeq, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import type { z } from 'zod'
import {
  NavItem,
  Profile,
  TYPE_FIELDS,
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

function parseItem(input: ItemInput) {
  const parsed = NavItem.safeParse(input)
  if (!parsed.success) throw new OpError(describeIssue(parsed.error))
  return parsed.data
}

function title(value: string): string {
  const t = value.trim()
  if (!t) throw new OpError('Heading title is required')
  return t
}

/** Plain object for a new item, in a readable key order, without empty fields. */
function newItemData(input: ItemInput): Record<string, unknown> {
  const item = parseItem(input)
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

function updateItemNode(doc: Document, node: YAMLMap, input: ItemInput) {
  const item = parseItem(input)
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

/** Apply ops in order; throws OpError if any op fails or the result is not a valid profile. */
export function applyOps(doc: Document, ops: Op[]): void {
  attachLeadingComments(doc)
  for (const op of ops) applyOp(doc, op)
  const result = Profile.safeParse(doc.toJS())
  if (!result.success) throw new OpError(describeIssue(result.error))
}
