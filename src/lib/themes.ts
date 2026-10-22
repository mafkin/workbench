// The looks a profile can pick (`theme:`): base colours for the tokens in
// theme.css, and a background of the theme's own, drawn with gradients so no
// image files are needed. The accent stays the profile's (`accent:`).
import { THEMES, type ThemeId } from '../../shared/config-schema.ts'

export interface Theme {
  id: ThemeId
  name: string
  note: string
  colors: {
    bg: string
    panel: string
    hover: string
    raised: string
    border: string
    borderStrong: string
    text: string
    textStrong: string
    muted: string
    faint: string
  }
  /** A CSS background: the theme's own, behind frosted panels. */
  backdrop: string
}

const glow = (x: string, y: string, w: number, h: number, rgb: string, a: number, end = 60) => `radial-gradient(${w}px ${h}px at ${x} ${y}, rgba(${rgb}, ${a}), transparent ${end}%)`

export const THEME_LIST: Theme[] = [
  {
    id: 'slate',
    name: 'Slate',
    note: 'The original slate and sage',
    colors: { bg: '#141518', panel: '#1b1d21', hover: '#22252a', raised: '#25282e', border: '#2a2d33', borderStrong: '#363a42', text: '#d4d6db', textStrong: '#eceef1', muted: '#8a8f98', faint: '#60656e' },
    backdrop: [glow('88%', '108%', 1200, 700, '143, 165, 138', 0.2), glow('8%', '-12%', 1000, 650, '125, 147, 171', 0.3), 'linear-gradient(160deg, #1d2128 0%, #131418 58%, #0e0f12 100%)'].join(', '),
  },
  {
    id: 'fjord',
    name: 'Fjord',
    note: 'Cool blue-grey, deep water',
    colors: { bg: '#10151b', panel: '#161d25', hover: '#1d2630', raised: '#212b36', border: '#26313d', borderStrong: '#33404e', text: '#d2dae3', textStrong: '#edf2f7', muted: '#8695a6', faint: '#5b6878' },
    backdrop: [glow('50%', '108%', 1500, 520, '150, 182, 204', 0.22), glow('14%', '0%', 900, 650, '64, 104, 146', 0.38, 65), 'linear-gradient(180deg, #0f1a26 0%, #13212d 55%, #0a1017 100%)'].join(', '),
  },
  {
    id: 'moss',
    name: 'Moss',
    note: 'Green-grey, forest floor',
    colors: { bg: '#121612', panel: '#181e18', hover: '#1f261f', raised: '#232b23', border: '#283128', borderStrong: '#354035', text: '#d4dbd2', textStrong: '#edf2eb', muted: '#8a9686', faint: '#5f6a5c' },
    backdrop: [glow('82%', '-4%', 1100, 720, '122, 152, 102', 0.24), glow('0%', '104%', 950, 620, '58, 92, 60', 0.4), 'linear-gradient(165deg, #182118 0%, #101510 68%, #0b0e0b 100%)'].join(', '),
  },
  {
    id: 'ember',
    name: 'Ember',
    note: 'Warm brown-grey, a low glow',
    colors: { bg: '#16120f', panel: '#1e1915', hover: '#26201b', raised: '#2a231d', border: '#322a23', borderStrong: '#40362d', text: '#e0d6cc', textStrong: '#f4ece4', muted: '#9d8f81', faint: '#6c6156' },
    backdrop: [glow('100%', '104%', 950, 620, '204, 122, 62', 0.28), glow('0%', '0%', 760, 520, '122, 82, 60', 0.26), 'linear-gradient(200deg, #1b1511 0%, #120e0b 70%, #0d0a08 100%)'].join(', '),
  },
  {
    id: 'dusk',
    name: 'Dusk',
    note: 'Muted plum, violet evening',
    colors: { bg: '#15121a', panel: '#1c1822', hover: '#241f2b', raised: '#282230', border: '#2e2836', borderStrong: '#3c3446', text: '#ddd5e4', textStrong: '#f1ecf6', muted: '#978da3', faint: '#665d72' },
    backdrop: [glow('28%', '110%', 1300, 620, '192, 122, 152', 0.22), glow('92%', '-2%', 950, 720, '120, 100, 182', 0.32), 'linear-gradient(170deg, #1e1727 0%, #141019 64%, #0e0b12 100%)'].join(', '),
  },
  {
    id: 'graphite',
    name: 'Graphite',
    note: 'Neutral near-black, quiet',
    colors: { bg: '#0f0f10', panel: '#161617', hover: '#1d1d1f', raised: '#222224', border: '#262628', borderStrong: '#333336', text: '#d6d6d8', textStrong: '#f0f0f2', muted: '#8c8c91', faint: '#5f5f64' },
    backdrop: 'radial-gradient(1300px 850px at 50% 38%, #1d1d20 0%, #0b0b0c 78%)',
  },
]

if (THEME_LIST.map((t) => t.id).join() !== THEMES.join()) throw new Error('THEME_LIST and THEMES differ')

export const themeById = (id: ThemeId): Theme => THEME_LIST.find((t) => t.id === id) ?? THEME_LIST[0]

const VARS: Record<keyof Theme['colors'], string> = {
  bg: '--bg',
  panel: '--panel',
  hover: '--hover',
  raised: '--raised',
  border: '--border',
  borderStrong: '--border-strong',
  text: '--text',
  textStrong: '--text-strong',
  muted: '--muted',
  faint: '--faint',
}

const tint = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/**
 * Put a theme's colours on :root and the background behind the panels: the
 * theme's own, or a picture under a tint of the theme's background colour.
 */
export function applyLook(theme: Theme, picture: string | null) {
  const root = document.documentElement.style
  for (const [key, name] of Object.entries(VARS)) root.setProperty(name, theme.colors[key as keyof Theme['colors']])
  const shade = tint(theme.colors.bg, 0.3)
  root.setProperty('--backdrop', picture ? `linear-gradient(${shade}, ${shade}), url("${picture}") center / cover no-repeat` : theme.backdrop)
}
