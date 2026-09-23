import { describe, expect, it } from 'vitest'
import {
  InMemorySemanticDefinitionStore,
  InMemorySemanticMappingRegistry,
  OntologyLookupService,
  SemanticDefinitionService,
} from '@ontology/semantic-engine'
import type { OntologyFactReferenceProvider } from '@ontology/semantic-engine'
import { OntologyLookupHandler } from '@ontology/tool-services'
import type { ToolExecutionRequest } from '@ontology/tool-services'
import { MAPPING_A, MAPPING_JOIN } from '../fixtures/semantic-mapping'
import {
  RecordingControlRepository,
  fixedClock,
  sampleCoreDraft,
  toolContext,
} from './semantic-definition-fixtures'
import { canonicalToolValidator } from './tool-gateway-fixtures'

const NAMESPACE = 'home-energy'

async function harness(facts?: OntologyFactReferenceProvider): Promise<{
  readonly service: OntologyLookupService
  readonly control: RecordingControlRepository
}> {
  const control = new RecordingControlRepository()
  const store = new InMemorySemanticDefinitionStore()
  const definitions = new SemanticDefinitionService({ store, control, now: fixedClock() })
  await definitions.publish(sampleCoreDraft(), toolContext())
  const mappings = new InMemorySemanticMappingRegistry([MAPPING_A, MAPPING_JOIN])
  return {
    service: new OntologyLookupService({ definitions, mappings, pageSize: 50, ...(facts === undefined ? {} : { facts }) }),
    control,
  }
}

describe('ontology_lookup local semantic reads', () => {
  it('marks a provider with more fact pages as incomplete instead of proving absence', async () => {
    const facts: OntologyFactReferenceProvider = {
      listFacts: (query) => Promise.resolve({
        facts: [{
          factRef: { id: query.cursor === undefined ? 'published-fact-1' : 'published-fact-2', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
          conceptRef: { namespace: NAMESPACE, conceptId: 'device' }, label: 'one indexed fact',
        }],
        nextCursor: query.cursor === undefined ? 'more-published-facts' : null, covered: query.cursor !== undefined,
      }),
    }
    const { service } = await harness(facts)
    const ctx = toolContext()
    const page = await service.lookup({
      scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      intent: 'facts', concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
    }, ctx)
    expect(page.output.items).toHaveLength(1)
    expect(page.completeness).toBe('partial')
    expect(page.nextCursor).toBe('more-published-facts')
    expect(page.output.gaps).toContainEqual(expect.stringMatching(/^facts_truncated:/))
    if (page.nextCursor === null) throw new Error('the first fact page must have a continuation cursor')
    const second = await service.lookup({
      scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      intent: 'facts', concepts: [{ namespace: NAMESPACE, conceptId: 'device' }], cursor: page.nextCursor,
    }, ctx)
    expect(second.output.items.map((item) => item.ref.id)).toEqual(['published-fact-2'])
    expect(second.completeness).toBe('complete')
    const handler = new OntologyLookupHandler({ lookup: service, sourceRef: { namespace: 'platform', sourceId: 'published-facts' } })
    const request: ToolExecutionRequest = {
      callId: '11111111-2222-4333-8444-555555555555', toolId: 'ontology_lookup',
      arguments: { scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, intent: 'facts', concepts: [{ namespace: NAMESPACE, conceptId: 'device' }] },
      resultLimits: { maxRows: 500, maxBytes: 262_144, maxDurationMs: 30_000 },
      deadline: ctx.deadline, traceId: ctx.traceId, ctx, signal: new AbortController().signal,
    }
    const outcome = await handler.execute(request)
    expect(outcome.status).toBe('partial')
    expect(outcome.coverage.truncated).toBe(true)
    expect(outcome.coverage.cursor).toBe('more-published-facts')

    const uncertain = await harness({ listFacts: () => Promise.resolve({
      facts: [{ factRef: { id: 'one-fact', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }, conceptRef: { namespace: NAMESPACE, conceptId: 'device' } }],
      nextCursor: null, covered: false,
    }) })
    const uncertainHandler = new OntologyLookupHandler({ lookup: uncertain.service, sourceRef: { namespace: 'platform', sourceId: 'uncertain-facts' } })
    const uncertainOutcome = await uncertainHandler.execute(request)
    expect(uncertainOutcome.status).toBe('partial')
    expect(uncertainOutcome.coverage.completeness).toBe('unknown')
  })
  it('paginates definitions and reports an explicit truncated page', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }

    const first = await service.lookup(
      {
        scopeRef,
        intent: 'definitions',
        concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
        limit: 2,
      },
      ctx,
    )
    expect(first.output.items).toHaveLength(2)
    expect(first.output.items.every((item) => item.kind === 'definition')).toBe(true)
    expect(first.nextCursor).not.toBeNull()
    expect(first.completeness).toBe('partial')

    const second = await service.lookup(
      {
        scopeRef,
        intent: 'definitions',
        concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
        limit: 2,
        ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
      },
      ctx,
    )
    const firstIds = new Set(first.output.items.map((item) => item.conceptRef?.conceptId))
    expect(second.output.items.some((item) => firstIds.has(item.conceptRef?.conceptId))).toBe(false)
  })

  it('reports an uncovered concept as a gap instead of fabricating a definition', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const page = await service.lookup(
      {
        scopeRef,
        intent: 'definitions',
        concepts: [{ namespace: NAMESPACE, conceptId: 'does_not_exist' }],
      },
      ctx,
    )
    expect(page.output.items).toHaveLength(0)
    expect(page.output.gaps).toContain('concept_uncovered:home-energy/does_not_exist')
    expect(page.completeness).toBe('unknown')
  })

  it('resolves a concept to a mapping reference and never presents it as an instance fact', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const page = await service.lookup(
      {
        scopeRef,
        intent: 'resolve',
        concepts: [{ namespace: NAMESPACE, conceptId: 'meter' }],
      },
      ctx,
    )
    expect(page.output.items.map((item) => item.kind)).toEqual(['mapping'])
    expect(page.output.items.some((item) => item.kind === 'fact')).toBe(false)
  })

  it('reports facts as uncovered and never returns a type path as an instance fact', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const page = await service.lookup(
      {
        scopeRef,
        intent: 'facts',
        concepts: [{ namespace: NAMESPACE, conceptId: 'meter' }],
      },
      ctx,
    )
    expect(page.output.items).toHaveLength(0)
    expect(page.output.gaps.some((gap) => gap.startsWith('facts_uncovered'))).toBe(true)
    expect(page.output.items.some((item) => item.kind === 'definition')).toBe(false)
    expect(page.completeness).toBe('unknown')
  })

  it('never publishes anything while answering a lookup', async () => {
    const { service, control } = await harness()
    const ctx = toolContext()
    const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const before = control.appended.length
    const page = await service.lookup(
      {
        scopeRef,
        intent: 'definitions',
        concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
      },
      ctx,
    )
    expect(page.output.autoPublished).toBe(false)
    expect(control.appended.length).toBe(before)
  })

  it('rejects a scope that does not match the trusted context', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    await expect(
      service.lookup(
        {
          scopeRef: { tenantId: '00000000-0000-4000-8000-000000000000', spaceId: ctx.allowedResources.spaceId },
          intent: 'definitions',
        },
        ctx,
      ),
    ).rejects.toThrow(/scope/i)
  })

  it('reports a truncated page through ToolCoverage and never auto-publishes', async () => {
    const { service } = await harness()
    const ctx = toolContext()
    const handler = new OntologyLookupHandler({
      lookup: service,
      sourceRef: { namespace: 'platform', sourceId: 'semantic-definitions' },
    })
    const request: ToolExecutionRequest = {
      callId: '11111111-2222-4333-8444-555555555555',
      toolId: 'ontology_lookup',
      arguments: {
        scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
        intent: 'definitions',
        concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
        limit: 1,
      },
      resultLimits: { maxRows: 500, maxBytes: 262_144, maxDurationMs: 30_000 },
      deadline: ctx.deadline,
      traceId: ctx.traceId,
      ctx,
      signal: new AbortController().signal,
    }
    const outcome = await handler.execute(request)
    expect(outcome.status).toBe('partial')
    expect(outcome.coverage.truncated).toBe(true)
    expect(outcome.coverage.cursor).toBeDefined()
    expect(outcome.sources).toHaveLength(1)
    const payload = outcome.payload as { readonly autoPublished: boolean; readonly gaps: readonly string[] }
    expect(payload.autoPublished).toBe(false)
    expect(Array.isArray(payload.gaps)).toBe(true)

    const validation = canonicalToolValidator().validateRef(
      'https://ontology.local/schema/tools.schema.json#/$defs/OntologyLookupOutput',
      outcome.payload,
    )
    expect(validation.valid).toBe(true)
  })
})
