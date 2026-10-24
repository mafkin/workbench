import { describe, expect, it } from 'vitest'
import { MASK, maskArgs, maskHeader, maskText, maskUrl, maskValue, scrub } from '../server/mask.ts'

describe('masking secrets', () => {
  it('hides every value but keeps ${VAR} references, which are names', () => {
    expect(maskValue('s3cr3t')).toBe(MASK)
    expect(maskValue('production')).toBe(MASK)
    expect(maskValue('${GITHUB_TOKEN}')).toBe('${GITHUB_TOKEN}')
    expect(maskValue('${A:-fallback-secret}')).toBe(MASK)
    expect(maskValue('')).toBe('')
  })

  it('keeps the scheme of an Authorization header', () => {
    expect(maskHeader('Bearer abc.def')).toBe(`Bearer ${MASK}`)
    expect(maskHeader('Bearer ${TOKEN}')).toBe('Bearer ${TOKEN}')
    expect(maskHeader('abc123')).toBe(MASK)
  })

  it('keeps a URL’s host and path, hiding user info and query values', () => {
    expect(maskUrl('https://api.example.com/mcp')).toBe('https://api.example.com/mcp')
    expect(maskUrl('https://me:hunter2@example.com/sse?key=abc&x=${X}#top')).toBe(`https://${MASK}@example.com/sse?key=${MASK}&x=\${X}#top`)
  })

  it('hides values after secret-looking flags, in assignments and in known token shapes', () => {
    expect(maskArgs(['-y', '@acme/mcp', '--api-key', 'k-123', '--token=t-456', '--port', '8080'])).toEqual(['-y', '@acme/mcp', '--api-key', MASK, `--token=${MASK}`, '--port', '8080'])
    expect(maskArgs(['--access-token', '${TOKEN}'])).toEqual(['--access-token', '${TOKEN}'])
    expect(maskArgs(['API_KEY=abc', 'MODE=fast', 'ghp_abcdefghijklmnop1234'])).toEqual([`API_KEY=${MASK}`, 'MODE=fast', MASK])
  })

  it('masks secrets inside a command line', () => {
    const text = maskText('curl -H "Authorization: Bearer sk-ant-abc123456789" --password hunter2 https://x.io/h?token=zzz && SLACK_TOKEN=xoxb-1-2 notify')
    expect(text).not.toMatch(/sk-ant|hunter2|zzz|xoxb/)
    expect(text).toContain('curl -H')
    expect(text).toContain('https://x.io/h?token=')
    expect(text).toContain('notify')
  })

  it('scrubs known values out of logs', () => {
    // Longest first, so a value inside another goes too; values under 4 characters stay (they would eat ordinary words).
    expect(scrub('connecting with abcd1234 to db as cd12', ['db', 'cd12', 'abcd1234'])).toBe(`connecting with ${MASK} to db as ${MASK}`)
  })
})
