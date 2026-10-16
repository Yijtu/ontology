import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NATIVE_TAVILY_PROVIDER_REF,
  NativeTavilySearchProvider,
  WebPageSnapshotArchiver,
  WebSearchProviderError,
} from '@ontology/adapter-search-web'
import { SecretValue } from '@ontology/contracts'
import type {
  BlobPutImmutableResponse,
  ImmutableArtifactWriter,
  WebSearchProviderRequest,
} from '@ontology/contracts'
import { gatewayContext } from './tool-gateway-fixtures'
import { createFixtureFetch, startTavilyFixture } from '../fixtures/web-search/tavily-fixture-server'
import type { TavilyFixture } from '../fixtures/web-search/tavily-fixture-server'

const ctx = gatewayContext()

const API_KEY = 'tvly-test-DO-NOT-LEAK-4f21'

function sha256(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function request(overrides?: Partial<WebSearchProviderRequest>): WebSearchProviderRequest {
  return {
    query: 'residential heat pump tariff',
    allowedDomains: ['example.com'],
    limit: 5,
    deadline: new Date(Date.now() + 5_000).toISOString(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

function provider(overrides?: { readonly archiver?: WebPageSnapshotArchiver }): NativeTavilySearchProvider {
  return new NativeTavilySearchProvider({
    baseUrl: 'https://api.tavily.com',
    apiKey: new SecretValue(API_KEY),
    fetchImpl: fetchFor,
    now: () => '2026-10-16T00:00:00Z',
    ...(overrides?.archiver === undefined ? {} : { snapshotArchive: overrides.archiver }),
  })
}

class RecordingArtifacts implements ImmutableArtifactWriter {
  readonly written: Uint8Array[] = []
  async putBytes(input: { readonly content: Uint8Array }): Promise<BlobPutImmutableResponse> {
    this.written.push(input.content)
    const digest = sha256(input.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
}

let fixture: TavilyFixture
let fetchFor: typeof fetch

beforeAll(async () => {
  fixture = await startTavilyFixture()
  fetchFor = createFixtureFetch(fixture)
})

afterAll(async () => {
  await fixture?.stop()
})

describe('native Tavily search adapter', () => {
  it('sends the fixed strategy: no answer, no auto parameters, no raw content, exact domains', async () => {
    fixture.setScenario({ results: [{ url: 'https://docs.example.com/tariff', content: 'Standing charges apply.' }] })
    await provider().search(request({ allowedDomains: ['example.com'] }), ctx)

    expect(fixture.requests).toHaveLength(1)
    const sent = fixture.requests[0]
    expect(sent?.method).toBe('POST')
    expect(sent?.authorizationPresent).toBe(true)
    expect(sent?.body).toMatchObject({
      query: 'residential heat pump tariff',
      include_answer: false,
      auto_parameters: false,
      include_raw_content: false,
      include_domains: ['example.com'],
      max_results: 5,
      search_depth: 'basic',
      topic: 'general',
    })
    // The vendor answer field is never requested; the response body carries no authored answer.
    expect(JSON.stringify(sent?.body)).not.toContain('"include_answer":true')
  })

  it('maps the vendor result into the platform page contract and returns usage', async () => {
    fixture.setScenario({
      results: [
        {
          url: 'https://docs.example.com/tariff',
          title: 'Heat pump tariff guide',
          content: 'Standing charges apply daily.',
          publishedDate: '2025-03-01T00:00:00Z',
          score: 0.97,
        },
      ],
      credits: 2,
      responseTime: 1.25,
    })
    const result = await provider().search(request(), ctx)

    expect(result.pages).toHaveLength(1)
    const page = result.pages[0]
    expect(page).toMatchObject({
      url: 'https://docs.example.com/tariff',
      title: 'Heat pump tariff guide',
      snippet: 'Standing charges apply daily.',
      publishedAt: '2025-03-01T00:00:00Z',
      fetchedAt: '2026-10-16T00:00:00Z',
    })
    expect(page?.contentDigest).toBe(sha256('Standing charges apply daily.'))
    // The vendor relevance score is dropped, never surfaced as a trust probability.
    expect(JSON.stringify(result)).not.toContain('0.97')
    expect(result.usage).toEqual({ creditsUsed: 2, responseTimeMs: 1250 })
    expect(result.excludedCount).toBe(0)
  })

  it('drops an out-of-allowlist result and counts it, never widening', async () => {
    fixture.setScenario({
      results: [
        { url: 'https://docs.example.com/tariff', content: 'inside' },
        { url: 'https://evil.example.net/exfiltrate', content: 'outside' },
      ],
    })
    const result = await provider().search(request(), ctx)
    expect(result.pages.map((page) => page.url)).toEqual(['https://docs.example.com/tariff'])
    expect(result.excludedCount).toBe(1)
  })

  it('reports a bounded recall range as truncated and never fabricates a total', async () => {
    fixture.setScenario({
      results: [
        { url: 'https://docs.example.com/a', content: 'a' },
        { url: 'https://docs.example.com/b', content: 'b' },
      ],
    })
    const result = await provider().search(request({ limit: 2 }), ctx)
    expect(result.truncated).toBe(true)
    expect(result.knownTotal).toBeUndefined()
  })

  it('maps a freshness hint onto the vendor time range', async () => {
    fixture.setScenario({ results: [] })
    await provider().search(request({ freshnessHint: 'month' }), ctx)
    expect(fixture.requests.at(-1)?.body).toMatchObject({ time_range: 'month' })
  })

  it('refuses an empty allowlist before any request leaves', async () => {
    fixture.setScenario({ results: [] })
    const before = fixture.requests.length
    await expect(provider().search(request({ allowedDomains: [] }), ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(fixture.requests).toHaveLength(before)
  })

  it('maps provider status codes onto the canonical catalogue', async () => {
    fixture.setScenario({ status: 401 })
    await expect(provider().search(request(), ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    fixture.setScenario({ status: 429, retryAfter: '3' })
    await expect(provider().search(request(), ctx)).rejects.toMatchObject({ code: 'RATE_LIMITED' })

    fixture.setScenario({ status: 503 })
    await expect(provider().search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('rejects a malformed or non-JSON body instead of reporting an empty success', async () => {
    fixture.setScenario({ rawBody: 'not json' })
    const failure = await provider()
      .search(request(), ctx)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WebSearchProviderError)
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE', malformedResponse: true })

    fixture.setScenario({
      rawBody: JSON.stringify({ results: [{ url: 'http://insecure.example.com', content: 'x' }] }),
    })
    await expect(provider().search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('refuses a redirect instead of following it to an unapproved host', async () => {
    fixture.setScenario({ redirectTo: 'https://evil.example.net/' })
    await expect(provider().search(request(), ctx)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('times out at the propagated deadline and marks the remote state unknown', async () => {
    fixture.setScenario({ results: [], delayMs: 3_000 })
    const failure = await provider()
      .search(request({ deadline: new Date(Date.now() + 150).toISOString() }), ctx)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'DEADLINE_EXCEEDED', remoteStateUnknown: true })
  })

  it('never leaks the API key into a result or an error', async () => {
    fixture.setScenario({ status: 503 })
    const failure = await provider()
      .search(request(), ctx)
      .then(() => undefined)
      .catch((error: unknown) => error)
    expect(JSON.stringify(failure)).not.toContain(API_KEY)
    fixture.setScenario({ results: [{ url: 'https://docs.example.com/x', content: 'ok' }] })
    const result = await provider().search(request(), ctx)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('names its own provider version ref, distinct from the compat gateway', () => {
    expect(provider().providerRef).toEqual(NATIVE_TAVILY_PROVIDER_REF)
    expect(NATIVE_TAVILY_PROVIDER_REF.id).toBe('web-search.tavily')
  })

  it('marks every page link-only when no archiver is configured', async () => {
    fixture.setScenario({ results: [{ url: 'https://docs.example.com/tariff', content: 'summary' }] })
    const result = await provider().search(request(), ctx)
    expect(result.pages[0]?.snapshotRef).toBeUndefined()
    expect(result.pages[0]?.snapshotUnavailableReason).toBe('archive_not_configured')
  })

  it('archives the actual page bytes, not the vendor summary, when an archiver is configured', async () => {
    const html = '<html><body><h1>Tariff</h1><p>Standing charges apply.</p></body></html>'
    fixture.setScenario({
      results: [{ url: 'https://docs.example.com/tariff', content: 'vendor summary only' }],
      pageHtml: html,
    })
    const artifacts = new RecordingArtifacts()
    const archiver = new WebPageSnapshotArchiver({
      artifacts,
      fetchImpl: fetchFor,
      now: () => '2026-10-16T09:00:00Z',
    })
    const result = await provider({ archiver }).search(request(), ctx)
    const page = result.pages[0]
    if (page?.snapshotRef === undefined) throw new Error('expected an archived page')

    expect(page.contentDigest).toBe(sha256(html))
    expect(page.contentDigest).not.toBe(sha256('vendor summary only'))
    expect(page.snapshotManifestRef).toBeDefined()
    expect(page.snapshotUnavailableReason).toBeUndefined()
    // The original bytes and the derived text are archived separately.
    expect(artifacts.written.some((chunk) => new TextDecoder().decode(chunk) === html)).toBe(true)
  })
})
