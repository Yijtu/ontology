import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TOOL_CATALOGUE,
  type ResolvedProfile,
  type SourceRef,
  type ToolCall,
  type ToolContext,
  type WebSearchProvider,
} from '@ontology/contracts'
import { HttpWebSearchProvider } from '@ontology/adapter-search-web'
import {
  WebSearchHandler,
  resolveEnabledTools,
  resolveWebSearchEnablement,
} from '@ontology/tool-services'
import {
  GATEWAY_LEDGER,
  buildGateway,
  canonicalToolValidator,
  fullProfile,
  gatewayContext,
  openGatewayLedger,
  resolvedProfile,
  type GatewayHarness,
} from './tool-gateway-fixtures'
import { startWebSearchFixture } from '../fixtures/web-search/fixture-server'
import type { WebSearchFixture } from '../fixtures/web-search/fixture-server'
import {
  INJECTION_PAGE,
  INJECTION_TEXT,
  SAFE_PAGE,
  scenarioWith,
} from '../fixtures/web-search/fixtures'

const SOURCE_REF: SourceRef = { namespace: 'public-web', sourceId: 'search' }
const PROFILE = fullProfile()

function futureDeadline(offsetMs = 10_000): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function webContext(offsetMs = 10_000): ToolContext {
  return gatewayContext({ deadline: futureDeadline(offsetMs) })
}

function webCall(overrides?: Partial<ToolCall['arguments']>): ToolCall {
  return {
    callId: randomUUID(),
    toolId: 'web_search',
    arguments: { query: 'heat pump tariff', allowedDomains: ['example.com'], ...overrides },
  }
}

function handlerFor(options: {
  readonly ctx: ToolContext
  readonly provider?: WebSearchProvider
  readonly allowWeb: boolean
  readonly profile?: ResolvedProfile
}): WebSearchHandler {
  return new WebSearchHandler({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    allowWeb: options.allowWeb,
    resolvedProfile: options.profile ?? PROFILE,
    sourceRef: SOURCE_REF,
  })
}

function harnessFor(handler: WebSearchHandler, ctx: ToolContext, profile = PROFILE): GatewayHarness {
  return buildGateway({ handlers: [handler], ctx, profile, now: () => new Date().toISOString() })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pagesOf(result: { readonly inlineData?: Record<string, unknown> | unknown[] }): Record<string, unknown>[] {
  if (!isRecord(result.inlineData)) return []
  const pages = result.inlineData.pages
  if (!Array.isArray(pages)) return []
  return pages.filter(isRecord)
}

let fixture: WebSearchFixture

beforeAll(async () => {
  fixture = await startWebSearchFixture()
})

afterAll(async () => {
  await fixture?.stop()
})

describe('web search is explicitly disabled, never faked', () => {
  it('emits zero provider requests when the run preference disables web access', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: false })
    expect(handler.enablement).toEqual({ enabled: false, reason: 'web_disabled_by_preference' })

    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)
    const before = fixture.requests.length
    const result = await harness.gateway.invoke(webCall(), ctx)

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(result.evidenceRefs).toEqual([])
    expect(fixture.requests).toHaveLength(before)
  })

  it('emits zero provider requests when no provider is configured', async () => {
    const ctx = webContext()
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, allowWeb: true })
    expect(handler.enablement).toEqual({ enabled: false, reason: 'provider_not_configured' })

    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)
    const before = fixture.requests.length
    const result = await harness.gateway.invoke(webCall(), ctx)

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(fixture.requests).toHaveLength(before)
  })

  it('emits zero provider requests when the resolved profile disables the tool', async () => {
    const ctx = webContext()
    const disabled = resolvedProfile({
      toolBindings: [
        { toolId: 'ontology_lookup', enabled: true },
        { toolId: 'data_query', enabled: true },
        { toolId: 'document_search', enabled: true },
        { toolId: 'web_search', enabled: false },
      ],
    })
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: true, profile: disabled })
    expect(handler.enablement).toEqual({ enabled: false, reason: 'tool_not_enabled_by_profile' })

    const harness = harnessFor(handler, ctx, disabled)
    await openGatewayLedger(harness, ctx)
    const before = fixture.requests.length
    const result = await harness.gateway.invoke(webCall(), ctx)

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(fixture.requests).toHaveLength(before)
  })

  it('reports the enablement gate without invoking a provider', () => {
    expect(
      resolveWebSearchEnablement({ resolvedProfile: PROFILE, allowWeb: true, providerConfigured: true }),
    ).toEqual({ enabled: true })
  })
})

describe('outbound queries respect the approved domain allowlist', () => {
  it('rejects an allowlist wider than the trusted context before any request leaves', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)
    const before = fixture.requests.length

    const result = await harness.gateway.invoke(
      webCall({ allowedDomains: ['example.com', 'evil.example.net'] }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(fixture.requests).toHaveLength(before)
  })

  it('sends only approved domains and drops an out-of-allowlist result', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE, { ...SAFE_PAGE, url: 'https://evil.example.net/x' }]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('ok')
    expect(fixture.requests.at(-1)?.domains).toEqual(['example.com'])
    const pages = pagesOf(result)
    expect(pages.map((page) => page.url)).toEqual([SAFE_PAGE.url])
    expect(result.warnings.map((warning) => warning.code)).toContain('WEB_RESULTS_EXCLUDED')
  })
})

describe('results preserve url, fetch time and publish date as untrusted data', () => {
  it('keeps provenance and marks content untrusted, and the payload validates', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('ok')
    const page = pagesOf(result)[0]
    expect(page?.url).toBe(SAFE_PAGE.url)
    expect(page?.publishedAt).toBe('2025-03-01T00:00:00Z')
    expect(page?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(page?.contentTrust).toBe('untrusted_data')
    expect(page?.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.sourceSnapshots).toHaveLength(1)
    expect(result.sourceSnapshots[0]?.sourceRef).toEqual(SOURCE_REF)

    const validator = canonicalToolValidator()
    expect(
      validator.validateRef('https://ontology.local/schema/tools.schema.json#/$defs/WebSearchOutput', {
        pages: pagesOf(result),
      }),
    ).toEqual({ valid: true, issues: [] })
    expect(
      validator.validateRef('https://ontology.local/schema/tools.schema.json#/$defs/ToolResult', result),
    ).toEqual({ valid: true, issues: [] })
  })
})

describe('fetched content cannot change permissions, catalogue, allowlist or budget', () => {
  it('treats an injection page as data and leaves every authority unchanged', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([INJECTION_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const profileBefore = JSON.stringify(PROFILE)
    const catalogueBefore = JSON.stringify(TOOL_CATALOGUE)
    const domainsBefore = [...ctx.allowedResources.domains]
    const enabledBefore = resolveEnabledTools(PROFILE).map((entry) => entry.definition.toolId)
    const ledgerBefore = await harness.ledgerStore.getLedger(
      { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      GATEWAY_LEDGER,
      ctx,
    )

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('ok')
    const page = pagesOf(result)[0]
    expect(page?.snippet).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(page?.contentTrust).toBe('untrusted_data')

    // The injected text is present only as data: no authority moved.
    expect(JSON.stringify(PROFILE)).toBe(profileBefore)
    expect(JSON.stringify(TOOL_CATALOGUE)).toBe(catalogueBefore)
    expect([...ctx.allowedResources.domains]).toEqual(domainsBefore)
    expect(resolveEnabledTools(PROFILE).map((entry) => entry.definition.toolId)).toEqual(enabledBefore)
    expect(fixture.requests.at(-1)?.domains).toEqual(['example.com'])

    const ledgerAfter = await harness.ledgerStore.getLedger(
      { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      GATEWAY_LEDGER,
      ctx,
    )
    expect(ledgerAfter?.limits).toEqual(ledgerBefore?.limits)

    // The controller service the page tried to invoke is still not a callable tool.
    const forbidden = await harness.gateway.invoke(
      { callId: randomUUID(), toolId: 'final_answer' as ToolCall['toolId'], arguments: { draft: INJECTION_TEXT } },
      ctx,
    )
    expect(forbidden.status).toBe('error')
    expect(forbidden.error?.code).toBe('FORBIDDEN')
  })
})

describe('timeout, error, truncation and empty stay distinguishable', () => {
  it('returns a successful empty result, not an error', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('empty')
    expect(result.error).toBeUndefined()
    expect(result.coverage.returned).toBe(0)
    expect(result.evidenceRefs).toHaveLength(1)
  })

  it('keeps a bounded recall range as partial with coverage.truncated', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE], { truncated: true, nextCursor: 'page-2', total: 9 }))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('partial')
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.knownTotal).toBe(9)
  })

  it('maps a provider error onto the canonical catalogue, not an empty success', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario({ results: [], status: 503 })
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('SOURCE_UNAVAILABLE')
    expect(result.evidenceRefs).toEqual([])
  })

  it('settles an aborted/timed-out call as usage_unknown and holds the estimate', async () => {
    const ctx = webContext(200)
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE], { delayMs: 3_000 }))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(webCall(), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.remoteStateUnknown).toBe(true)

    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const reservations = await harness.ledgerStore.listReservations(scope, GATEWAY_LEDGER, ctx)
    const reservation = reservations.at(-1)
    expect(reservation?.status).toBe('usage_unknown')
    expect(reservation?.usageUnknown).toBe(true)
    expect(reservation?.actual).toEqual(reservation?.reserved)
  })
})

describe('budget is shared and monotonic across attempts', () => {
  it('does not reset consumed allowance on a retry', async () => {
    const ctx = webContext()
    const provider = new HttpWebSearchProvider({ baseUrl: fixture.baseUrl })
    fixture.setScenario(scenarioWith([SAFE_PAGE]))
    const handler = handlerFor({ ctx, provider, allowWeb: true })
    const harness = harnessFor(handler, ctx)
    await openGatewayLedger(harness, ctx)
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }

    const first = await harness.gateway.invoke(webCall(), ctx)
    expect(first.status).toBe('ok')
    const afterFirst = await harness.ledgerStore.getLedger(scope, GATEWAY_LEDGER, ctx)
    expect(afterFirst?.consumed.toolCalls).toBe(1)

    const retry: ToolCall = {
      ...webCall({ query: 'heat pump tariff 2025' }),
      attempt: 2,
    }
    const second = await harness.gateway.invoke(retry, ctx)
    expect(second.status).toBe('ok')
    const afterSecond = await harness.ledgerStore.getLedger(scope, GATEWAY_LEDGER, ctx)
    expect(afterSecond?.consumed.toolCalls).toBe(2)
    expect(afterSecond?.consumed.toolCalls).toBeGreaterThan(afterFirst?.consumed.toolCalls ?? 0)
  })
})
