// The service can start programs, so only the app itself may call it:
// - Host must be loopback with our port (blocks DNS rebinding),
// - a browser Origin, if sent, must be ours (blocks other sites' forms and fetches),
// - API calls must carry X-Workbench, which a cross-site request cannot add
//   without a CORS preflight that this service never approves.
import type { IncomingHttpHeaders } from 'node:http'

export const API_HEADER = 'x-workbench'

export function makeGuard(ports: number[]) {
  const hosts = new Set(ports.flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]))
  const origins = new Set([...hosts].map((h) => `http://${h}`))

  return function check(headers: IncomingHttpHeaders, url: string): string | null {
    if (!headers.host || !hosts.has(headers.host)) return 'Host not allowed'
    if (headers.origin && !origins.has(headers.origin)) return 'Origin not allowed'
    if (headers['sec-fetch-site'] === 'cross-site') return 'Cross-site request'
    if (url.startsWith('/api/') && headers[API_HEADER] !== '1') return 'Missing X-Workbench header'
    return null
  }
}
