import { describe, expect, it } from 'vitest'
import type { ScopeRef, VersionRef } from '@ontology/contracts'
import {
  InMemorySemanticDefinitionStore,
  OntologyLookupService,
  SemanticDefinitionService,
  SemanticMappingError,
} from '@ontology/semantic-engine'
import type { MaterializationPublishedSource, OntologyFactQuery, PublishedSemanticData, RuleFact } from '@ontology/semantic-engine'
import { PublishedFactsReferenceProvider } from '../../packages/semantic-engine/src/mapping/published-facts'
import { RecordingControlRepository, toolContext } from './semantic-definition-fixtures'

const NAMESPACE = 'home-energy'
const scopeRef: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}
const definitionRef: VersionRef = {
  id: 'home-energy.core',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}
const evidenceRef = {
  id: '22222222-3333-4444-8555-666666666666',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
  kind: 'evidence' as const,
}

function fact(overrides: Partial<RuleFact> & { readonly assertionId: string; readonly subject: string; readonly sourceStatementId: string }): RuleFact {
  return {
    logicalAssertionId: `${overrides.sourceStatementId}#operating_hours`,
    recordedSeq: '1',
    op: 'assert',
    predicate: 'operating_hours',
    value: { amount: '12.50', unit: 'h' },
    objectId: 'device',
    attributeId: 'operating_hours',
    schemaRef: definitionRef,
    validity: { validFrom: '2026-09-20T00:00:00Z', validTo: '2026-09-25T00:00:00Z' },
    sourceRef: { namespace: 'published-statement', sourceId: overrides.sourceStatementId },
    sourceRefs: [evidenceRef],
    ...overrides,
  }
}

class MutablePublishedSource implements MaterializationPublishedSource {
  data: PublishedSemanticData

  constructor(data: PublishedSemanticData) {
    this.data = data
  }

  async load(): Promise<PublishedSemanticData> {
    return this.data
  }
}

async function lookup(source: MutablePublishedSource, pageSize = 2): Promise<OntologyLookupService> {
  const definitions = new SemanticDefinitionService({
    store: new InMemorySemanticDefinitionStore(),
    control: new RecordingControlRepository(),
  })
  return new OntologyLookupService({
    definitions,
    facts: new PublishedFactsReferenceProvider({ source, namespace: NAMESPACE, definitionRef, now: () => '2026-09-24T00:00:00Z' }),
    pageSize,
    maxPageSize: 200,
  })
}

function baseData(facts: readonly RuleFact[]): PublishedSemanticData {
  return {
    facts,
    rules: [],
    entityBindings: [],
    definitionRef,
    readRevision: { semantic: '4', identity: '7' },
    historicalAsOfSupported: false,
    complete: true,
  }
}

function conceptQuery(overrides: Partial<OntologyFactQuery> = {}): OntologyFactQuery {
  return {
    scopeRef,
    concepts: [{ namespace: NAMESPACE, conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
    entityRefs: [],
    limit: 1,
    ...overrides,
  }
}

describe('published facts ontology lookup bridge', () => {
  it('pages real projected facts statelessly and binds subject, concept, valid time and parent provenance', async () => {
    const facts = [
      fact({ assertionId: 'statement-T01#operating_hours@1', sourceStatementId: 'statement-T01', subject: 'entity-T01' }),
      fact({ assertionId: 'statement-T01b#operating_hours@1', sourceStatementId: 'statement-T01b', subject: 'entity-T01' }),
      fact({ assertionId: 'statement-T02#operating_hours@1', sourceStatementId: 'statement-T02', subject: 'entity-T02' }),
      fact({
        assertionId: 'statement-T03#operating_hours@1',
        sourceStatementId: 'statement-T03',
        subject: 'entity-T03',
        validity: { validFrom: '2026-10-01T00:00:00Z' },
      }),
    ]
    const source = new MutablePublishedSource(baseData(facts))
    const service = await lookup(source, 1)
    const provider = new PublishedFactsReferenceProvider({ source, namespace: NAMESPACE, definitionRef, now: () => '2026-09-24T00:00:00Z' })
    const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])
    const entityT01 = [{ id: 'entity-T01', version: '1.0.0', digest: evidenceRef.digest, kind: 'dataset' as const }]
    const query = {
      scopeRef,
      intent: 'facts' as const,
      concepts: [{ namespace: NAMESPACE, conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
      entityRefs: entityT01,
      limit: 1,
    }

    const first = await service.lookup(query, ctx)
    expect(first.completeness).toBe('partial')
    expect(first.output.items).toHaveLength(1)
    expect(first.output.items[0]).toMatchObject({
      kind: 'fact',
      conceptRef: { namespace: NAMESPACE, conceptId: 'operating_hours', definitionVersion: '1.0.0' },
      payload: {
        subjectEntityId: 'entity-T01',
        objectId: 'device',
        attributeId: 'operating_hours',
        value: { amount: '12.50', unit: 'h' },
        schemaRef: definitionRef,
        sourceStatementId: expect.stringMatching(/^statement-T01/),
        sourceRefs: [evidenceRef],
      },
    })
    expect(first.output.items[0]?.ref.version).toBe('1.0.0')
    expect(first.output.definitionVersion).toEqual(definitionRef)
    expect(first.nextCursor).not.toBeNull()

    const cursor = first.nextCursor ?? undefined
    const second = await service.lookup({ ...query, ...(cursor === undefined ? {} : { cursor }) }, ctx)
    expect(second.completeness).toBe('complete')
    expect(second.output.items[0]?.payload).toMatchObject({ sourceStatementId: 'statement-T01b' })
    expect(second.output.items[0]?.payload).not.toMatchObject({ subjectEntityId: 'entity-T02' })

    // Replaying a page token is a valid read retry; it yields the same page, while the next
    // cursor moves forward from its source-fact key rather than wrapping to an offset 0 page.
    const repeated = await service.lookup({ ...query, ...(cursor === undefined ? {} : { cursor }) }, ctx)
    expect(repeated.output.items).toEqual(second.output.items)
    expect(repeated.nextCursor).toBe(second.nextCursor)

    const readAll = async () => {
      const references: string[] = []
      let next: string | undefined
      for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
        const page = await provider.listFacts({
          ...conceptQuery({ entityRefs: entityT01, limit: 1 }),
          ...(next === undefined ? {} : { cursor: next }),
        }, ctx)
        expect(page.covered).toBe(true)
        references.push(...page.facts.map((entry) => entry.factRef.id))
        next = page.nextCursor ?? undefined
        if (next === undefined) return references
      }
      throw new Error('fact scan exceeded the expected bound')
    }
    const [firstScan, concurrentScan] = await Promise.all([readAll(), readAll()])
    expect(concurrentScan).toEqual(firstScan)

    const validTimePage = await new PublishedFactsReferenceProvider({
      source,
      namespace: NAMESPACE,
      definitionRef,
      now: () => '2026-09-24T00:00:00Z',
    }).listFacts({
      ...conceptQuery({ limit: 10 }),
      validAt: '2026-09-24T00:00:00Z',
    }, ctx)
    expect(validTimePage.covered).toBe(true)
    expect(validTimePage.facts).toHaveLength(3)
    expect(validTimePage.facts.some((entry) => entry.factRef.id.startsWith('statement-T03'))).toBe(false)
  })

  it('filters retracted, future and half-open expired facts at the current valid time pinned by the cursor', async () => {
    let currentTime = '2026-09-24T00:00:00Z'
    const source = new MutablePublishedSource(baseData([
      fact({ assertionId: 'statement-current-A#operating_hours@1', sourceStatementId: 'statement-current-A', subject: 'entity-A' }),
      fact({ assertionId: 'statement-current-B#operating_hours@1', sourceStatementId: 'statement-current-B', subject: 'entity-B' }),
      fact({
        assertionId: 'statement-expired#operating_hours@1',
        sourceStatementId: 'statement-expired',
        subject: 'entity-expired',
        validity: { validFrom: '2026-09-20T00:00:00Z', validTo: currentTime },
      }),
      fact({
        assertionId: 'statement-future#operating_hours@1',
        sourceStatementId: 'statement-future',
        subject: 'entity-future',
        validity: { validFrom: '2026-09-25T00:00:00Z' },
      }),
      fact({
        assertionId: 'statement-retracted#operating_hours@2',
        sourceStatementId: 'statement-retracted',
        subject: 'entity-retracted',
        recordedSeq: '2',
        op: 'retract',
      }),
    ]))
    const provider = new PublishedFactsReferenceProvider({
      source,
      namespace: NAMESPACE,
      definitionRef,
      now: () => currentTime,
    })
    const query = conceptQuery({ entityRefs: [], limit: 1 })
    const first = await provider.listFacts(query, toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin']))
    expect(first.covered).toBe(true)
    expect(first.facts).toHaveLength(1)
    expect(first.facts[0]?.factRef.id).toBe('statement-current-A#operating_hours@1')
    expect(first.nextCursor).not.toBeNull()

    // The next page must keep the first page's current-time cut even if wall clock moves.
    currentTime = '2026-10-02T00:00:00Z'
    const firstCursor = first.nextCursor
    if (firstCursor === null) throw new Error('current facts did not return a page cursor')
    const second = await provider.listFacts({ ...query, cursor: firstCursor }, toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin']))
    expect(second.covered).toBe(true)
    expect(second.facts.map((entry) => entry.factRef.id)).toEqual(['statement-current-B#operating_hours@1'])
    expect(second.facts.some((entry) => /expired|future|retracted/.test(entry.factRef.id))).toBe(false)
  })

  it('rejects historical fallback, incomplete identity snapshots and a changed revision between pages', async () => {
    const source = new MutablePublishedSource(baseData([
      fact({ assertionId: 'statement-one#operating_hours@1', sourceStatementId: 'statement-one', subject: 'entity-one' }),
      fact({ assertionId: 'statement-two#operating_hours@1', sourceStatementId: 'statement-two', subject: 'entity-two' }),
    ]))
    const provider = new PublishedFactsReferenceProvider({ source, namespace: NAMESPACE, definitionRef, now: () => '2026-09-24T00:00:00Z' })
    const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])
    const query = conceptQuery()
    const first = await provider.listFacts(query, ctx)
    expect(first.covered).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const historical = await provider.listFacts({ ...query, timeContext: { asOf: '2026-09-20T00:00:00Z', timeZone: 'UTC' } }, ctx)
    expect(historical.covered).toBe(false)
    expect(historical.facts).toEqual([])
    expect(historical.issues?.[0]).toMatch(/historical asOf is unsupported/)

    source.data = { ...source.data, readRevision: { semantic: '5', identity: '7' } }
    const cursor = first.nextCursor
    if (cursor === null) throw new Error('first facts page did not return a cursor')
    const changedRevision = await provider.listFacts({ ...query, cursor }, ctx)
    expect(changedRevision.covered).toBe(false)
    expect(changedRevision.facts).toEqual([])
    expect(changedRevision.issues?.[0]).toMatch(/revision changed/)

    source.data = { ...baseData(source.data.facts), complete: false, issues: [{ code: 'IDENTITY_UNCONFIRMED', message: 'one current entity is unbound' }] }
    const incomplete = await provider.listFacts(query, ctx)
    expect(incomplete.covered).toBe(false)
    expect(incomplete.facts).toEqual([])
    expect(incomplete.issues?.join(' ')).toMatch(/IDENTITY_UNCONFIRMED/)

    await expect(provider.listFacts({ ...query, scopeRef: { tenantId: '00000000-0000-4000-8000-000000000000', spaceId: scopeRef.spaceId } }, ctx))
      .rejects.toBeInstanceOf(SemanticMappingError)
  })

  it('marks object-wide and unfiltered fact queries limited because relations and derived facts are not read', async () => {
    const source = new MutablePublishedSource(baseData([
      fact({ assertionId: 'statement-device#operating_hours@1', sourceStatementId: 'statement-device', subject: 'entity-device' }),
    ]))
    const provider = new PublishedFactsReferenceProvider({ source, namespace: NAMESPACE, definitionRef, now: () => '2026-09-24T00:00:00Z' })
    const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])

    const objectWide = await provider.listFacts(conceptQuery({
      concepts: [{ namespace: NAMESPACE, conceptId: 'device' }],
    }), ctx)
    expect(objectWide.facts).toHaveLength(1)
    expect(objectWide.covered).toBe(false)
    expect(objectWide.issues?.join(' ')).toMatch(/relation and derived facts are not covered/)

    const allFacts = await provider.listFacts(conceptQuery({ concepts: [] }), ctx)
    expect(allFacts.covered).toBe(false)
    expect(allFacts.issues?.join(' ')).toMatch(/relation and derived facts are not included/)
  })
})
