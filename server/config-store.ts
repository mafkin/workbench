// What is left of the YAML profile store (parts 1 to 10): the parser for a
// profile still in YAML, read read-only until it is moved to pages, and the
// error type every service throws. The store itself is server/wiki.ts.
import { LineCounter, parseDocument } from 'yaml'
import type { z } from 'zod'
import { Profile, type ConfigError } from '../shared/config-schema.ts'

export class StoreError extends Error {
  status: number
  /** Extra fields for the response body, e.g. the current rev on a conflict. */
  data?: Record<string, unknown>
  constructor(message: string, status: number, data?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.data = data
  }
}

/** The first issue of a failed parse as `path: message`. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid value'
  const path = issue.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '')
  return path ? `${path}: ${issue.message}` : issue.message
}

export function parseProfile(text: string): { profile: Profile | null; error: ConfigError | null } {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, prettyErrors: false })
  const yamlError = doc.errors[0]
  if (yamlError) {
    const pos = lineCounter.linePos(yamlError.pos[0])
    return { profile: null, error: { message: yamlError.message.split('\n')[0], line: pos.line, col: pos.col } }
  }
  const result = Profile.safeParse(doc.toJS())
  if (result.success) return { profile: result.data, error: null }
  // Point at the closest node that exists, e.g. the item missing a required field.
  let at = result.error.issues[0]?.path ?? []
  let range: [number, number, number] | undefined
  for (;;) {
    const node = doc.getIn(at, true) as { range?: [number, number, number] } | undefined
    if (node?.range) {
      range = node.range
      break
    }
    if (at.length === 0) break
    at = at.slice(0, -1)
  }
  const pos = range ? lineCounter.linePos(range[0]) : undefined
  return { profile: null, error: { message: describeIssue(result.error), line: pos?.line, col: pos?.col } }
}
