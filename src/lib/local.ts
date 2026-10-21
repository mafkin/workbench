import { useCallback, useState } from 'react'

// Per-browser conveniences (nav width, collapsed headings, selection). Storage
// can be unavailable or cleared; the app works the same without it.
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`workbench:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(`workbench:${key}`, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function useLocal<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readLocal(key, fallback))
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
        writeLocal(key, next)
        return next
      })
    },
    [key],
  )
  return [value, set]
}
