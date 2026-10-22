// Secret values never leave the service: env values, headers, passwords and
// query values in URLs, values after secret-looking flags, and well-known token
// shapes are replaced before anything is sent to the browser. `${VAR}`
// references stay readable, since they are names, not values.

export const MASK = '••••••'

const REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
const SECRET_WORD = String.raw`(?:token|secret|passw(?:or)?d|pass|api[-_]?key|key|auth|credential)`
const SECRET_FLAG = new RegExp(String.raw`^--?[\w-]*${SECRET_WORD}[\w-]*$`, 'i')
const FLAG_VALUE = new RegExp(String.raw`(--?[\w-]*${SECRET_WORD}[\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)`, 'gi')
const ASSIGNMENT = new RegExp(String.raw`\b([A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"'&;|]+)`, 'gi')
const SCHEME = /\b(Bearer|Basic|Token)\s+([^\s"']+)/g
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const TOKEN_SHAPES =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_\w{10,}|github_pat_\w{10,}|xox[abprs]-[\w-]{3,}|glpat-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{20,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g

/** Any value as the mask, except an empty one or a plain `${VAR}` reference. */
export function maskValue(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value)
  if (s === '' || REF.test(s.trim())) return s
  return MASK
}

const maskQuoted = (v: string) => {
  const q = v[0]
  return (q === '"' || q === "'") && v.endsWith(q) && v.length > 1 ? `${q}${maskValue(v.slice(1, -1))}${q}` : maskValue(v)
}

/** A header value: the scheme of `Bearer …` stays. */
export function maskHeader(value: unknown): string {
  const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(String(value ?? ''))
  return m ? `${m[1]} ${maskValue(m[2])}` : maskValue(value)
}

/** The scheme, host and path stay; user info and query values go. */
export function maskUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]*)@/i, (_, scheme: string) => `${scheme}${MASK}@`)
    .replace(/([?&][^=&#]*=)([^&#]*)/g, (_, key: string, v: string) => key + maskValue(v))
}

/** Secrets inside free text: a command line, a hook, an error. */
export function maskText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (u) => maskUrl(u))
    .replace(SCHEME, (_, scheme: string, v: string) => `${scheme} ${maskValue(v)}`)
    .replace(FLAG_VALUE, (_, flag: string, sep: string, v: string) => `${flag}${sep}${maskQuoted(v)}`)
    .replace(ASSIGNMENT, (_, key: string, v: string) => `${key}=${maskQuoted(v)}`)
    .replace(TOKEN_SHAPES, MASK)
}

/** Program arguments: the one after a secret-looking flag is masked whole. */
export function maskArgs(args: unknown[]): string[] {
  const words = args.map((a) => String(a))
  return words.map((a, i) => (i > 0 && SECRET_FLAG.test(words[i - 1]) && !a.startsWith('-') ? maskValue(a) : maskText(a)))
}

/** Known secret values (a server's env and headers) taken out of a log. */
export function scrub(text: string, secrets: string[]): string {
  let out = text
  for (const s of [...secrets].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK)
  return out
}
