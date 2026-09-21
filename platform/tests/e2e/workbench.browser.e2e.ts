import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROFILE, SENTINEL_SECRET, sampleProfileSpec, startHarness } from '../ui/workbench-fixtures'
import type { Harness } from '../ui/workbench-fixtures'

/**
 * Real-browser E2E for the configuration workbench.
 *
 * The built app is served by a loopback-only static host that proxies `/api` to the real
 * Fastify server (in-memory stores), so the page exercises the actual HTTP surface and the
 * actual responsive CSS. This suite is NOT part of `pnpm run verify`: it needs the Playwright
 * browser binaries and the web build. Run it with `pnpm run test:e2e` after `pnpm run
 * build:web`.
 *
 * The API harness mints a fixed principal because a browser cannot attach the test identity
 * headers. That is test-only and the host binds to 127.0.0.1; production uses verified OIDC
 * and never a fixed principal (SPEC §3).
 */
const DIST_DIR = fileURLToPath(new URL('../../apps/web/dist', import.meta.url))
const ARTIFACTS_DIR = fileURLToPath(new URL('./artifacts', import.meta.url))

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

interface WebHost {
  readonly origin: string
  close(): Promise<void>
}

function send(res: import('node:http').ServerResponse, status: number, contentType: string, body: string | Buffer): void {
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

async function startWebHost(apiOrigin: string): Promise<WebHost> {
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

let harness: Harness
let web: WebHost
let browser: Browser

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS_DIR, `${name}.png`), fullPage: true })
}

async function record(name: string, lines: readonly string[]): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  await writeFile(join(ARTIFACTS_DIR, `${name}.log`), `${lines.join('\n')}\n`, 'utf8')
}

beforeAll(async () => {
  harness = await startHarness({ fixedPrincipal: true })
  if (!harness.baseUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('the E2E harness must bind to loopback only')
  }
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.app.close().catch(() => undefined)
})

describe('workbench in a real browser', () => {
  it('runs the happy path on desktop: preflight, degradations, activation, no secret', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(web.origin)
    await page.waitForSelector('[data-testid="preflight"]')
    expect(await page.getAttribute('.workbench', 'data-viewport')).toBe('desktop')

    await page.click('[data-testid="preflight"]')
    await page.waitForSelector('[data-testid="preflight-status"][data-status="resolved"]')
    const degradationCount = await page.locator('[data-testid="degradation"]').count()
    expect(degradationCount).toBeGreaterThanOrEqual(2)

    await page.click('[data-testid="activate"]')
    await page.waitForSelector('[data-testid="active-revision"]')
    const activeRevision = await page.textContent('[data-testid="active-revision"]')
    expect(activeRevision).toContain('1')

    const html = await page.content()
    expect(html).not.toContain(SENTINEL_SECRET)
    expect(await page.textContent('[data-testid="source-secret-ref"]')).toBe('secret://vault/telemetry')
    await capture(page, 'desktop-happy-path')
    await record('desktop-happy-path', [
      `origin=${web.origin}`,
      'viewport=1280x900',
      `degradations=${degradationCount}`,
      `activeRevision=${activeRevision ?? ''}`,
      `containsSecret=${html.includes(SENTINEL_SECRET)}`,
    ])
    await context.close()
  })

  it('renders the narrow layout and keeps the error path visible', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(web.origin)
    await page.waitForSelector('[data-testid="preflight"]')
    expect(await page.getAttribute('.workbench', 'data-viewport')).toBe('narrow')

    const gridColumns = await page.$eval('.workbench__body', (node) =>
      getComputedStyle(node).gridTemplateColumns,
    )
    expect(gridColumns.trim().split(/\s+/).length).toBe(1)

    // The happy path already activated revision 1, so an activation from a fresh page that
    // does not know the revision must surface a conflict instead of overwriting.
    await page.click('[data-testid="preflight"]')
    await page.waitForSelector('[data-testid="preflight-status"][data-status="resolved"]')
    await page.click('[data-testid="activate"]')
    await page.waitForSelector('[data-testid="conflict"]')
    expect(await page.getAttribute('[data-testid="conflict"]', 'data-code')).toBe('VERSION_CONFLICT')

    await capture(page, 'narrow-conflict')
    await record('narrow-conflict', [
      `viewport=390x844`,
      `gridTemplateColumns=${gridColumns}`,
      `conflictCode=VERSION_CONFLICT`,
    ])
    await context.close()
  })

  it('shows the not-configured state with capability gaps', async () => {
    const built = await startHarness({ fixedPrincipal: true, withoutTelemetry: true })
    const host = await startWebHost(built.baseUrl)
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(host.origin)
      await page.waitForSelector('[data-testid="preflight"]')
      await page.click('[data-testid="preflight"]')
      await page.waitForSelector('[data-state="not_configured"]')
      const gap = await page.textContent('[data-testid="capability-gap"]')
      expect(gap).toContain('telemetry_read')
      await capture(page, 'not-configured')
      await record('not-configured', [`gap=${gap ?? ''}`])
    } finally {
      await context.close()
      await host.close()
      await built.app.close()
    }
  })

  it('keeps a bound run on its original resolved manifest after the UI switches profiles', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-lock-run' },
      payload: {
        profileRef: { id: PROFILE.id, version: PROFILE.version },
        question: 'lock my version in the browser',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
      },
    })
    expect(created.statusCode).toBe(202)
    const run = (created.json() as { data: { runId: string; resolvedProfileHash: string } }).data

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?run=${run.runId}`)
    await page.waitForSelector('[data-testid="bound-run-hash"]')
    expect(await page.textContent('[data-testid="bound-run-hash"]')).toBe(run.resolvedProfileHash)

    // Switch the workbench onto a different profile version through its own HTTP client.
    const alt = { id: 'home-energy-alt', version: '1.0.0' }
    await harness.client.publishProfile({
      profileRef: alt,
      spec: sampleProfileSpec(),
      environment: 'local_dev',
    })
    const preflightAlt = await harness.client.preflightProfile(alt)
    const altHash = preflightAlt.resolvedProfile?.snapshotHash
    if (altHash === undefined) throw new Error('the alternate profile did not resolve')
    await harness.client.activateProfile({ profileRef: alt, snapshotHash: altHash, expectedRevision: null })

    await page.reload()
    await page.waitForSelector('[data-testid="bound-run-hash"]')
    expect(await page.textContent('[data-testid="bound-run-hash"]')).toBe(run.resolvedProfileHash)
    await capture(page, 'bound-run-lock')
    await record('bound-run-lock', [
      `runId=${run.runId}`,
      `runHash=${run.resolvedProfileHash}`,
      `activatedAltHash=${altHash}`,
      'afterSwitchHash=' + (await page.textContent('[data-testid="bound-run-hash"]')),
    ])
    await context.close()
  })
})
