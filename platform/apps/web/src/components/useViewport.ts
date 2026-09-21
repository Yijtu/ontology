import { useEffect, useState } from 'react'

export type Viewport = 'narrow' | 'desktop'

/** The breakpoint the responsive stylesheet uses. Kept in one place so the JS and CSS agree. */
export const NARROW_MAX_WIDTH = 720

export function viewportOf(width: number): Viewport {
  return width < NARROW_MAX_WIDTH ? 'narrow' : 'desktop'
}

/**
 * Track the viewport width so the app can render a distinct narrow layout. The stylesheet
 * also has the media query; this hook exists so the narrow path is exercised and asserted
 * rather than only reachable by resizing a real window.
 */
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => viewportOf(window.innerWidth))
  useEffect(() => {
    const onResize = () => setViewport(viewportOf(window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return viewport
}
