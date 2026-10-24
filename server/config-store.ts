// The error type every service throws, and the zod issue formatter. The store
// itself is server/wiki.ts (the pages are the configuration since part 11).
import type { z } from 'zod'

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
