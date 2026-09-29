import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWebViteConfig } from '../../apps/web/vite.config'

describe('Core Vite launcher configuration', () => {
  it('serves apps/web from the launcher cwd and keeps the legacy 5173 port by default', () => {
    const config = createWebViteConfig({})

    if (config.root === undefined) throw new Error('Vite root is not configured')
    expect(resolve(config.root)).toBe(resolve('apps/web'))
    expect(config.server?.port).toBe(5_173)
    expect(config.server?.proxy).toBeUndefined()
  })

  it('uses the isolated Core web port and proxies same-origin API requests to the Core API', () => {
    const config = createWebViteConfig({ CORE_WEB_PORT: '5174', VITE_CORE_API_PORT: '3001' })

    expect(config.server?.port).toBe(5_174)
    expect(config.server?.proxy).toEqual({
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    })
  })

  it('rejects malformed API proxy ports instead of silently falling back', () => {
    expect(() => createWebViteConfig({ VITE_CORE_API_PORT: 'not-a-port' })).toThrow(/VITE_CORE_API_PORT/u)
    expect(() => createWebViteConfig({ CORE_WEB_PORT: '65536' })).toThrow(/CORE_WEB_PORT/u)
  })
})
