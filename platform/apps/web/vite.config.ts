import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
function portOf(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback
  if (!/^[1-9]\d{0,4}$/u.test(value)) throw new Error(`${name} must be a valid TCP port`)
  const port = Number(value)
  if (port > 65_535) throw new Error(`${name} must be a valid TCP port`)
  return port
}

export function createWebViteConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const coreApiPort = environment['VITE_CORE_API_PORT'] === undefined
    ? undefined
    : portOf(environment['VITE_CORE_API_PORT'], 'VITE_CORE_API_PORT', 3_001)

/**
 * The browser app is a plain Vite build. It talks to the API over HTTP only; no server
 * package is imported here. The production bundle is served by whatever host fronts the
 * API (the E2E harness serves `dist/` and proxies `/api` to the Fastify server).
 */
  return defineConfig({
  root: webRoot,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(webRoot, 'index.html'),
        scenarioMountHarness: resolve(webRoot, 'scenario-mount-harness.html'),
        workspaceHarness: resolve(webRoot, 'workspace-harness.html'),
        instanceReviewHarness: resolve(webRoot, 'instance-review-harness.html'),
        definitionWorkbenchHarness: resolve(webRoot, 'definition-workbench-harness.html'),
        projectHarness: resolve(webRoot, 'project-harness.html'),
      },
    },
  },
  server: {
    port: portOf(environment['CORE_WEB_PORT'], 'CORE_WEB_PORT', 5_173),
    ...(coreApiPort === undefined
      ? {}
      : {
          proxy: {
            '/api': {
              target: `http://127.0.0.1:${String(coreApiPort)}`,
              changeOrigin: false,
            },
          },
        }),
  },
})
}

export default createWebViteConfig()
