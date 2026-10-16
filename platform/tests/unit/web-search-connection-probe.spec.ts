import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebSearchConnectionProbe } from '@ontology/adapter-search-web'
import { assertToolConnectionProbeResultShape, SecretValue } from '@ontology/contracts'
import type {
  BlobPutImmutableResponse,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopeRef,
  ScopedArtifactReader,
  SecretValue as SecretValueType,
  ToolConnectionDescriptor,
  ToolCredentialCustodian,
  ToolContext,
} from '@ontology/contracts'
import { gatewayContext } from './tool-gateway-fixtures'
import { createFixtureFetch, startTavilyFixture } from '../fixtures/web-search/tavily-fixture-server'
import type { TavilyFixture } from '../fixtures/web-search/tavily-fixture-server'

const ctx: ToolContext = gatewayContext()
const scopeRef: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
const CREDENTIAL_REF: ResourceRef = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  version: '1.0.0',
  digest: `sha256:${'c'.repeat(64)}`,
  kind: 'artifact',
}
const API_KEY = 'tvly-probe-DO-NOT-LEAK-77aa'

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

class StaticCredentials implements ToolCredentialCustodian {
  readonly #secret: SecretValueType | undefined
  constructor(secret: string | undefined) {
    this.#secret = secret === undefined ? undefined : new SecretValue(secret)
  }
  async stage(): Promise<ResourceRef> {
    return CREDENTIAL_REF
  }
  async activate(): Promise<void> {}
  async discard(): Promise<void> {}
  async revoke(): Promise<void> {}
  async resolve(): Promise<SecretValueType> {
    if (this.#secret === undefined) throw new Error('no credential')
    return this.#secret
  }
}

class InMemoryArtifacts implements ImmutableArtifactWriter, ScopedArtifactReader {
  readonly #store = new Map<string, Uint8Array>()
  corruptReads = false
  async putBytes(input: { readonly content: Uint8Array }): Promise<BlobPutImmutableResponse> {
    const id = randomUUID()
    const digest = sha256(input.content)
    this.#store.set(id, input.content)
    return {
      blobRef: { id, version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
  async read(request: { readonly approvedInputRefs: readonly ResourceRef[] }): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    const bytes = ref === undefined ? new Uint8Array() : this.#store.get(ref.id) ?? new Uint8Array()
    if (!this.corruptReads || bytes.byteLength === 0) return bytes
    const copy = new Uint8Array(bytes)
    copy[0] = (copy[0] ?? 0) ^ 0xff
    return copy
  }
}

/** A fetch that rejects every request, to model an unreachable host rather than an HTTP error. */
const unreachableFetch: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))

let fixture: TavilyFixture
let routedFetch: typeof fetch

beforeAll(async () => {
  fixture = await startTavilyFixture()
  routedFetch = createFixtureFetch(fixture)
})

afterAll(async () => {
  await fixture?.stop()
})

function descriptor(overrides?: Partial<ToolConnectionDescriptor>): ToolConnectionDescriptor {
  return {
    name: 'Native Tavily',
    adapterType: 'native_tavily',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://api.tavily.com',
    ...overrides,
  }
}

function probe(overrides?: {
  readonly credentials?: ToolCredentialCustodian
  readonly artifacts?: InMemoryArtifacts
  readonly withArchive?: boolean
  readonly fetchImpl?: typeof fetch
  readonly maxTimeoutMs?: number
  readonly compatEndpointPath?: string
}) {
  const artifacts = overrides?.artifacts
  return createWebSearchConnectionProbe({
    credentials: overrides?.credentials ?? new StaticCredentials(API_KEY),
    searchQuery: 'probe heat pump tariff',
    searchDomains: ['example.com'],
    ...(overrides?.withArchive === false || artifacts === undefined
      ? {}
      : {
          testPage: { url: 'https://docs.example.com/probe-page', domains: ['example.com'] },
          artifacts,
          artifactReader: artifacts,
        }),
    fetchImpl: overrides?.fetchImpl ?? routedFetch,
    now: () => '2026-10-16T00:00:00Z',
    ...(overrides?.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: overrides.maxTimeoutMs }),
    ...(overrides?.compatEndpointPath === undefined ? {} : { compatEndpointPath: overrides.compatEndpointPath }),
  })
}

describe('two-item web-search connection probe', () => {
  it('passes the search item with a real query and the archive item with a byte read-back', async () => {
    fixture.setScenario({
      results: [{ url: 'https://docs.example.com/tariff', content: 'live result' }],
      pageHtml: '<html><body><h1>Readable</h1><p>Standing charges apply.</p></body></html>',
    })
    const result = await probe({ artifacts: new InMemoryArtifacts() }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )

    assertToolConnectionProbeResultShape(result)
    expect(result.credentialConfigured).toBe(true)
    expect(result.search.status).toBe('passed')
    expect(result.archive.status).toBe('passed')
    expect(result.draft).toBe(true)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('reports the two items separately: search can pass while archive fails', async () => {
    fixture.setScenario({ results: [{ url: 'https://docs.example.com/tariff', content: 'x' }], pageStatus: 500 })
    const result = await probe({ artifacts: new InMemoryArtifacts() }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(result.search.status).toBe('passed')
    expect(result.archive).toMatchObject({ status: 'failed', reason: 'page_not_readable' })
  })

  it('reports not_configured for both items when no endpoint is set', async () => {
    const result = await probe().probe(
      scopeRef,
      { draft: { name: 'Native Tavily', adapterType: 'native_tavily', capabilities: ['web_search'], enabled: true } },
      ctx,
    )
    expect(result.credentialConfigured).toBe(false)
    expect(result.search).toMatchObject({ status: 'skipped', reason: 'not_configured' })
    expect(result.archive).toMatchObject({ status: 'skipped', reason: 'not_configured' })
  })

  it('reports authentication_failed when a native connection has no resolvable credential', async () => {
    fixture.setScenario({ results: [] })
    const result = await probe({ credentials: new StaticCredentials(undefined) }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(result.credentialConfigured).toBe(false)
    expect(result.search).toMatchObject({ status: 'failed', reason: 'authentication_failed' })
    expect(JSON.stringify(result)).not.toContain(API_KEY)
  })

  it('classifies a rate limit, a malformed response and an unreachable host distinctly', async () => {
    fixture.setScenario({ status: 429 })
    expect((await probe().probe(scopeRef, { draft: descriptor(), credentialRef: CREDENTIAL_REF }, ctx)).search).toMatchObject({
      status: 'failed',
      reason: 'rate_limited',
    })

    fixture.setScenario({ rawBody: 'not json', contentType: 'application/json' })
    expect((await probe().probe(scopeRef, { draft: descriptor(), credentialRef: CREDENTIAL_REF }, ctx)).search).toMatchObject({
      status: 'failed',
      reason: 'invalid_response',
    })

    const unreachable = await probe({ fetchImpl: unreachableFetch }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(unreachable.search).toMatchObject({ status: 'failed', reason: 'unreachable' })
  })

  it('times out the search item on its own budget, independent of the run', async () => {
    fixture.setScenario({ results: [], delayMs: 3_000 })
    const result = await probe({ maxTimeoutMs: 120 }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(result.search).toMatchObject({ status: 'failed', reason: 'timeout' })
  })

  it('does not fake an archive pass: no archiver means the archive item is not_configured', async () => {
    fixture.setScenario({ results: [{ url: 'https://docs.example.com/tariff', content: 'x' }] })
    const result = await probe({ withArchive: false }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(result.search.status).toBe('passed')
    expect(result.archive).toMatchObject({ status: 'skipped', reason: 'not_configured' })
  })

  it('fails the archive item with digest_mismatch when read-back bytes do not match', async () => {
    fixture.setScenario({
      results: [],
      pageHtml: '<html><body><p>Integrity matters.</p></body></html>',
    })
    const artifacts = new InMemoryArtifacts()
    artifacts.corruptReads = true
    const result = await probe({ artifacts }).probe(
      scopeRef,
      { draft: descriptor(), credentialRef: CREDENTIAL_REF },
      ctx,
    )
    expect(result.archive).toMatchObject({ status: 'failed', reason: 'digest_mismatch' })
  })

  it('probes a compat-gateway connection over its own HTTP dialect', async () => {
    const result = await probe({
      fetchImpl: globalThis.fetch,
      withArchive: false,
      compatEndpointPath: '/search',
    }).probe(
      scopeRef,
      { draft: descriptor({ adapterType: 'http_compat', endpoint: fixture.baseUrl }) },
      ctx,
    )
    expect(result.search.status).toBe('passed')
    expect(result.archive).toMatchObject({ status: 'skipped', reason: 'not_configured' })
    expect(fixture.requests.some((entry) => entry.method === 'GET' && entry.path === '/search')).toBe(true)
  })

  it('skips both items when the connection does not serve web_search', async () => {
    const result = await probe().probe(
      scopeRef,
      { draft: descriptor({ capabilities: ['document_search'] }) },
      ctx,
    )
    expect(result.search).toMatchObject({ status: 'skipped', reason: 'not_configured' })
    expect(result.archive).toMatchObject({ status: 'skipped', reason: 'not_configured' })
  })
})
