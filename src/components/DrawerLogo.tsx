import { CATEGORY_PALETTE } from '../../shared/config-schema.ts'
import { useLogo } from '../lib/logos.ts'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w][0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** A steady tint per name, from the category palette. */
function tint(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length]
}

/** A drawer's logo, or its initials on a tinted square. */
export function DrawerLogo({ name, logo, size }: { name: string; logo?: string; size: number }) {
  const url = useLogo(logo)
  return (
    <span
      className="drawer-logo"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), '--tint': tint(name) } as React.CSSProperties}
      aria-hidden="true"
    >
      {url ? <img src={url} alt="" /> : initials(name)}
    </span>
  )
}
