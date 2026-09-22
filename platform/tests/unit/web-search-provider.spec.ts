import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WebSearchProviderRequest } from '@ontology/contracts'
import {
  HttpWebSearchProvider,
  WebSearchProviderError,
  hostAllowed,
  providerErrorForHttpStatus,
} from '@ontology/adapter-search-web'
import { gatewayContext } from './tool-gateway-fixtures'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import { OUTSIDE_ALLOWLIST_PAGE, SAFE_PAGE, scenarioWith } from '../fixtures/web-search/fixtures'

const ctx = gatewayContext()

function request(overrides?: Partial<WebSearchProviderRequest>): WebSearchProviderRequest {
  return {
    query: 'heat pump tariff',
    allowedDomains: ['example.com'],
    limit: 10,
    deadline: new Date(Date.now() + 5_000).toISOString(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

let fixture: WebSearchFixture
let provider: HttpWebSearchProvider

beforeAll(async () => {
  fixture = await startWebSearchFixture()
  provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
})

afterAll(async () => {
  await fixture?.stop()
})

describe('replaceable HTTP provider', () => {
  it('sends exactly the approved allowlist and preserves url, fetch time and publish date', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const result = await provider.search(request(), ctx)

    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]?.domains).toEqual(['example.com'])
    expect(fixture.requests[0]?.query).toBe('heat pump tariff')

    expect(result.pages).toHaveLength(1)
    const page = result.pages[0]
    expect(page?.url).toBe(SAFE_PAGE.url)
    expect(page?.publishedAt).toBe('2025-03-01T00:00:00Z')
    expect(page?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(page?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.excludedCount).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('drops a result whose host is outside the allowlist and counts it, never widening', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE, OUTSIDE_ALLOWLIST_PAGE]))
    const result = await provider.search(request(), ctx)
    expect(result.pages.map((page) => page.url)).toEqual([SAFE_PAGE.url])
    expect(result.excludedCount).toBe(1)
  })

  it('accepts a subdomain of an approved domain but not a lookalike', () => {
    expect(hostAllowed('https://docs.example.com/x', ['example.com'])).toBe(true)
    expect(hostAllowed('https://example.com/x', ['example.com'])).toBe(true)
    expect(hostAllowed('https://evil.example.net/x', ['example.com'])).toBe(false)
    expect(hostAllowed('https://notexample.com/x', ['example.com'])).toBe(false)
  })

  it('reports an empty result as an empty page set, not an error', async () => {
    fixture.setScenario(scenarioWith([]))
    const result = await provider.search(request(), ctx)
    expect(result.pages).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('marks a bounded recall range as truncated with a cursor', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE], { truncated: true, nextCursor: 'page-2', total: 42 }))
    const result = await provider.search(request({ limit: 1 }), ctx)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBe('page-2')
    expect(result.knownTotal).toBe(42)
  })

  it('maps provider status codes onto the canonical catalogue', async () => {
    fixture.setScenario({ results: [], status: 503 })
    await expect(provider.search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })

    fixture.setScenario({ results: [], status: 429, retryAfter: '7' })
    await expect(provider.search(request(), ctx)).rejects.toMatchObject({ code: 'RATE_LIMITED' })

    fixture.setScenario({ results: [], status: 400 })
    await expect(provider.search(request(), ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })

    expect(providerErrorForHttpStatus(413, 'too big').code).toBe('RESULT_TOO_LARGE')
    expect(providerErrorForHttpStatus(418, 'teapot').code).toBe('INTERNAL_ERROR')
  })

  it('rejects a malformed provider body instead of reporting an empty success', async () => {
    fixture.setScenario({ results: [], rawBody: 'not json' })
    await expect(provider.search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })

    fixture.setScenario({ results: [], rawBody: JSON.stringify({ results: [{ url: 'http://insecure.example.com' }] }) })
    await expect(provider.search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('times out at the propagated deadline and marks the remote state unknown', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE], { delayMs: 3_000 }))
    const failure = await provider
      .search(request({ deadline: new Date(Date.now() + 150).toISOString() }), ctx)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WebSearchProviderError)
    expect(failure).toMatchObject({ code: 'DEADLINE_EXCEEDED', remoteStateUnknown: true })
  })

  it('refuses an empty allowlist before any request leaves', async () => {
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const before = fixture.requests.length
    await expect(provider.search(request({ allowedDomains: [] }), ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(fixture.requests).toHaveLength(before)
  })
})
