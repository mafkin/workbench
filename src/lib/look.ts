// What the rest of the UI can do with the profile's look: the file browser
// offers "Use as background" and "Use as drawer logo" on pictures.
import { createContext, useContext } from 'react'

export interface LookApi {
  /** Copy a picture from the profile's folders and make it the background. */
  pictureFrom: (path: string) => void
  /** Make a picture the shown drawer's logo (scaled to 64×64). */
  logoFrom: (path: string) => void
}

export const LookCtx = createContext<LookApi | null>(null)

export const useLook = () => useContext(LookCtx)

/** Pictures the backgrounds folder keeps (raster only). */
export const PICTURE_EXT = /\.(jpe?g|png|webp|avif|gif)$/i
