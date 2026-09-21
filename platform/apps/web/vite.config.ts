import { defineConfig } from 'vite'

/**
 * The browser app is a plain Vite build. It talks to the API over HTTP only; no server
 * package is imported here. The production bundle is served by whatever host fronts the
 * API (the E2E harness serves `dist/` and proxies `/api` to the Fastify server).
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
})
