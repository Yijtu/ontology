import { describe, expect, it } from 'vitest'
import { InMemoryIndustrySchemaSource } from '@ontology/application'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { EntityCandidateRecallService, InMemoryIdentityIndexReader } from '@ontology/semantic-engine'
import type {
  EntityRecallRequest,
  IdentityIndexEntry,
  IdentityRecallResult,
  SimilarityBackend,
} from '@ontology/semantic-engine'
import type { BudgetLedgerPort, DocumentSearchPort, EntityCandidate } from '@ontology/contracts'
import {
  IDENTITY_DEFINITION_REF,
  IDENTITY_DIMENSIONS,
  CountingSimilarityBackend,
  FakeDocumentSearchPort,
  entityCandidate,
  indexEntry,
} from './identity-fixtures'
import { buildIndustrySchema } from './extraction-fixtures'
import {
  RecordingControlRepository,
  SPACE_A,
  SPACE_B,
  TENANT_A,
  TENANT_B,
  toolContext,
} from './component-registry-fixtures'

const CTX_A = toolContext(TENANT_A, SPACE_A)
const CTX_B = toolContext(TENANT_B, SPACE_B)
const LEDGER_ID = '77777777-7777-4777-8777-777777777777'

interface HarnessOptions {
  readonly documents?: DocumentSearchPort
  readonly similarity?: SimilarityBackend
  readonly budget?: BudgetLedgerPort
}

function makeService(entries: readonly IdentityIndexEntry[], options: HarnessOptions = {}): EntityCandidateRecallService {
  return new EntityCandidateRecallService({
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: IDENTITY_DEFINITION_REF, schema: buildIndustrySchema(IDENTITY_DEFINITION_REF) },
    ]),
    index: new InMemoryIdentityIndexReader(entries, () => '2026-09-22T00:00:00Z'),
    ...(options.documents === undefined ? {} : { documents: options.documents }),
    ...(options.similarity === undefined ? {} : { similarity: options.similarity }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })
}

function request(candidate: EntityCandidate, overrides: Partial<EntityRecallRequest> = {}): EntityRecallRequest {
  return {
    definitionRef: IDENTITY_DEFINITION_REF,
    candidate,
    observedText: overrides.observedText ?? 'Charger One',
    scopeDimensionValues: overrides.scopeDimensionValues ?? { ...IDENTITY_DIMENSIONS },
    ...(overrides.validAt === undefined ? {} : { validAt: overrides.validAt }),
    ...(overrides.limit === undefined ? {} : { limit: overrides.limit }),
    ...(overrides.contextCollections === undefined ? {} : { contextCollections: overrides.contextCollections }),
    ...(overrides.allowSimilarity === undefined ? {} : { allowSimilarity: overrides.allowSimilarity }),
    ...(overrides.ledgerId === undefined ? {} : { ledgerId: overrides.ledgerId }),
  }
}

function withBudget(): { readonly budget: BudgetLedgerPort; readonly store: InMemoryBudgetLedgerStore } {
  const store = new InMemoryBudgetLedgerStore()
  const service = new BudgetService({
    store,
    control: new RecordingControlRepository(),
    now: () => '2026-09-22T00:00:00Z',
  })
  return { budget: service, store }
}

describe('entity candidate recall — identity scope and layered strategies', () => {
  it('prefers a stable native identifier over a same-name fuzzy match', async () => {
    const entries = [
      indexEntry({ entityId: 'E-A', nativeId: 'DEV-1', displayName: 'Charger One', normalizedName: 'charger one' }),
      indexEntry({ entityId: 'E-B', nativeId: 'DEV-2', displayName: 'Charger One', normalizedName: 'charger one' }),
    ]
    const result = await makeService(entries).recall(request(entityCandidate()), CTX_A)

    expect(result.outcome).toBe('candidates')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.entityId).toBe('E-A')
    expect(result.candidates[0]?.strategy).toBe('strong_identifier')
    expect(result.candidates[0]?.stableId).toBe(true)
    expect(result.strategiesUsed).toEqual(['strong_identifier'])
  })

  it('prefers a confirmed alias over a same-name entity with no alias', async () => {
    const entries = [
      indexEntry({
        entityId: 'E-ALIAS',
        alias: 'Charger One',
        aliasNormalized: 'charger one',
        aliasConfirmed: true,
        displayName: 'Charger A',
        normalizedName: 'charger a',
      }),
      indexEntry({ entityId: 'E-NAME', displayName: 'Charger One', normalizedName: 'charger one' }),
    ]
    const candidate = entityCandidate({ attributes: [{ attributeId: 'device_name', value: 'Charger One' }] })
    const result = await makeService(entries).recall(request(candidate), CTX_A)

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.entityId).toBe('E-ALIAS')
    expect(result.candidates[0]?.strategy).toBe('confirmed_alias')
    expect(result.candidates[0]?.aliasConfirmed).toBe(true)
  })

  it('honours a historical (valid-time) alias and preserves its interval', async () => {
    const entries = [
      indexEntry({
        entityId: 'E-HIST',
        alias: 'Old Name',
        aliasNormalized: 'old name',
        aliasConfirmed: true,
        aliasValidFrom: '2020-01-01T00:00:00Z',
        aliasValidTo: '2021-01-01T00:00:00Z',
        displayName: 'Charger A',
        normalizedName: 'charger a',
      }),
    ]
    const candidate = entityCandidate({ attributes: [] })
    const service = makeService(entries)

    const inside = await service.recall(
      request(candidate, { observedText: 'Old Name', validAt: '2020-06-01T00:00:00Z' }),
      CTX_A,
    )
    expect(inside.candidates).toHaveLength(1)
    expect(inside.candidates[0]?.aliasValidFrom).toBe('2020-01-01T00:00:00Z')
    expect(inside.candidates[0]?.aliasValidTo).toBe('2021-01-01T00:00:00Z')

    const outside = await service.recall(
      request(candidate, { observedText: 'Old Name', validAt: '2022-01-01T00:00:00Z' }),
      CTX_A,
    )
    expect(outside.outcome).toBe('undecided')
    expect(outside.candidates).toHaveLength(0)
  })

  it('never mixes same-name entities across tenant, site or type', async () => {
    const entries = [
      indexEntry({ entityId: 'E-MATCH', displayName: 'Shared Charger', normalizedName: 'shared charger' }),
      indexEntry({
        entityId: 'E-SITE',
        displayName: 'Shared Charger',
        normalizedName: 'shared charger',
        dimensions: { ...IDENTITY_DIMENSIONS, site: 'site-b' },
      }),
      indexEntry({
        entityId: 'E-TYPE',
        displayName: 'Shared Charger',
        normalizedName: 'shared charger',
        dimensions: { ...IDENTITY_DIMENSIONS, device_type: 'inverter' },
      }),
      indexEntry({
        entityId: 'E-TENANT',
        tenantId: TENANT_B,
        spaceId: SPACE_B,
        displayName: 'Shared Charger',
        normalizedName: 'shared charger',
      }),
    ]
    const candidate = entityCandidate({ attributes: [] })
    const service = makeService(entries)

    const scopedA = await service.recall(request(candidate, { observedText: 'Shared Charger' }), CTX_A)
    expect(scopedA.candidates.map((entry) => entry.entityId)).toEqual(['E-MATCH'])

    const scopedB = await service.recall(request(candidate, { observedText: 'Shared Charger' }), CTX_B)
    expect(scopedB.candidates.map((entry) => entry.entityId)).toEqual(['E-TENANT'])
  })

  it('preserves the pre-normalisation text, the strategy and the truncation state', async () => {
    const entries = [
      indexEntry({ entityId: 'E-1', displayName: 'Charger One', normalizedName: 'charger one' }),
      indexEntry({ entityId: 'E-2', displayName: 'Charger One', normalizedName: 'charger one' }),
      indexEntry({ entityId: 'E-3', displayName: 'Charger One', normalizedName: 'charger one' }),
    ]
    const candidate = entityCandidate({ attributes: [] })
    const result = await makeService(entries).recall(
      request(candidate, { observedText: '  Charger   ONE  ', limit: 2 }),
      CTX_A,
    )

    expect(result.observedText).toBe('  Charger   ONE  ')
    expect(result.normalizedText).toBe('charger one')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((entry) => entry.strategy === 'context')).toBe(true)
    expect(result.candidates.every((entry) => entry.matchedValue === 'charger one')).toBe(true)
    expect(result.truncation).toEqual({ truncated: true, limit: 2, boundedCandidateGeneration: true })
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.knownTotal).toBe(3)
    expect(result.coverage.completeness).toBe('truncated')
  })

  it('reports undecided rather than proving absence when the bounded recall is empty', async () => {
    const result = await makeService([]).recall(request(entityCandidate({ attributes: [] })), CTX_A)

    expect(result.outcome).toBe('undecided')
    expect(result.reason).toBe('NO_CANDIDATE')
    expect(result.candidates).toHaveLength(0)
    // A bounded recall can never be read as a complete enumeration of the corpus.
    expect(result.coverage.boundedRecall).toBe(true)
    expect(result.coverage.returned).toBe(0)
  })

  it('resolves the identity scope from the published definition, not from a display name', async () => {
    const entries = [indexEntry({ entityId: 'E-1', nativeId: 'DEV-1', displayName: 'Charger One', normalizedName: 'charger one' })]
    const service = makeService(entries)
    const unknownObject = entityCandidate({ objectId: 'not-declared', attributes: [] })
    await expect(service.recall(request(unknownObject), CTX_A)).rejects.toMatchObject({
      code: 'IDENTITY_SCOPE_NOT_FOUND',
    })

    const missingDimension = entityCandidate({ attributes: [] })
    await expect(
      service.recall(request(missingDimension, { scopeDimensionValues: { source: 'docs', site: 'site-a' } }), CTX_A),
    ).rejects.toMatchObject({ code: 'MISSING_SCOPE_DIMENSION' })
  })
})

describe('entity candidate recall — bounded similarity and evidence', () => {
  it('reports the similarity path unavailable instead of presenting keyword-only as similarity', async () => {
    const entries = [indexEntry({ entityId: 'E-1', displayName: 'Charger One', normalizedName: 'charger one' })]
    const result = await makeService(entries).recall(
      request(entityCandidate({ attributes: [] })),
      CTX_A,
    )

    expect(result.similarity.available).toBe(false)
    expect(result.similarity.reason).toBe('NOT_CONFIGURED')
    expect(result.similarity.comparisons).toBe(0)
    expect(result.candidates.every((entry) => entry.strategy !== 'similarity')).toBe(true)
  })

  it('bounds model-backed comparisons by the candidate set, not the corpus size', async () => {
    const candidate = entityCandidate({ attributes: [] })
    const limit = 5

    const smallBackend = new CountingSimilarityBackend()
    const smallBudget = withBudget()
    await smallBudget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'run' }, CTX_A)
    const small = makeService(
      Array.from({ length: 3 }, (_value, index) =>
        indexEntry({ entityId: `E-${index}`, displayName: 'Charger One', normalizedName: 'charger one' }),
      ),
      { similarity: smallBackend, budget: smallBudget.budget },
    )
    const smallResult = await small.recall(
      request(candidate, { observedText: 'Charger One', limit, ledgerId: LEDGER_ID }),
      CTX_A,
    )
    expect(smallBackend.calls).toBe(1)
    expect(smallBackend.pairCount).toBe(3)
    expect(smallResult.similarity.available).toBe(true)
    expect(smallResult.similarity.comparisons).toBe(1)

    const largeBackend = new CountingSimilarityBackend()
    const largeBudget = withBudget()
    await largeBudget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'run' }, CTX_A)
    const large = makeService(
      Array.from({ length: 200 }, (_value, index) =>
        indexEntry({ entityId: `E-${String(index).padStart(3, '0')}`, displayName: 'Charger One', normalizedName: 'charger one' }),
      ),
      { similarity: largeBackend, budget: largeBudget.budget },
    )
    await large.recall(request(candidate, { observedText: 'Charger One', limit, ledgerId: LEDGER_ID }), CTX_A)

    // The comparison count is bounded by the recall limit and does not grow with the corpus.
    expect(largeBackend.calls).toBe(1)
    expect(largeBackend.pairCount).toBe(limit)
    expect(largeBackend.pairCount).toBeLessThan(200)

    // The model-backed comparison settled through the shared budget.
    const reservations = await smallBudget.store.listReservations(
      { tenantId: TENANT_A, spaceId: SPACE_A },
      LEDGER_ID,
      CTX_A,
    )
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('settled')
  })

  it('attaches real document context evidence through the injected search port', async () => {
    const documents = new FakeDocumentSearchPort()
    documents.setSpans([
      {
        documentRef: { id: 'doc-1', version: '1.0.0', digest: `sha256:${'4'.repeat(64)}`, kind: 'document' },
        locator: { kind: 'offset', startOffset: 0, endOffset: 10 },
        quoteDigest: `sha256:${'5'.repeat(64)}`,
        spanKind: 'verbatim',
        score: 1.5,
      },
    ])
    const entries = [indexEntry({ entityId: 'E-1', displayName: 'Charger One', normalizedName: 'charger one' })]
    const result = await makeService(entries, { documents }).recall(
      request(entityCandidate({ attributes: [] }), {
        observedText: 'Charger One',
        contextCollections: ['manuals/a'],
      }),
      CTX_A,
    )

    expect(documents.requests).toHaveLength(1)
    expect(documents.requests[0]?.query).toBe('Charger One')
    expect(result.documentContext).toEqual({ performed: true, spans: 1, completeness: 'complete' })
    expect(result.candidates[0]?.evidenceRefs.map((ref) => ref.id)).toContain('doc-1')
    expect(result.sourceSnapshots.length).toBeGreaterThanOrEqual(2)
  })
})

function assertRecallResult(result: IdentityRecallResult): void {
  expect(result.coverage.boundedRecall).toBe(true)
}

describe('entity candidate recall — result shape', () => {
  it('always marks the recall as bounded', async () => {
    const result = await makeService([]).recall(request(entityCandidate({ attributes: [] })), CTX_A)
    assertRecallResult(result)
  })
})
