import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

/**
 * A loopback-only static host that serves the built web app and proxies `/api` to the real
 * Fastify server, so a browser E2E exercises the actual HTTP surface and the actual
 * responsive CSS. Shared by the workbench and review browser suites.
 */

const DIST_DIR = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))
export const ARTIFACTS_DIR = fileURLToPath(new URL('./artifacts', import.meta.url))

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export interface WebHost {
  readonly origin: string
  close(): Promise<void>
}

function send(
  res: import('node:http').ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

async function serveStatic(pathname: string, res: import('node:http').ServerResponse): Promise<void> {
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''))
  const candidate = resolve(DIST_DIR, relative)
  if (candidate !== resolve(DIST_DIR) && !candidate.startsWith(`${resolve(DIST_DIR)}${sep}`)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden')
    return
  }
  try {
    const file = await readFile(candidate)
    send(res, 200, CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream', file)
  } catch {
    // SPA fallback: an unknown path still serves the app shell.
    const shell = await readFile(join(DIST_DIR, 'index.html'))
    send(res, 200, 'text/html; charset=utf-8', shell)
  }
}

export async function startWebHost(apiOrigin: string): Promise<WebHost> {
  const api = new URL(apiOrigin)
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/api/')) {
      const proxy = httpRequest(
        { hostname: api.hostname, port: api.port, path: url, method: req.method, headers: req.headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
          proxyRes.pipe(res)
        },
      )
      proxy.on('error', () => send(res, 502, 'text/plain; charset=utf-8', 'api proxy failed'))
      req.pipe(proxy)
      return
    }
    void serveStatic(url, res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the web host did not bind a port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
      }),
  }
}

export async function capture(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS_DIR, `${name}.png`), fullPage: true })
}

export async function record(name: string, lines: readonly string[]): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  await writeFile(join(ARTIFACTS_DIR, `${name}.log`), `${lines.join('\n')}\n`, 'utf8')
}
