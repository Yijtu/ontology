import { createToolContext } from '@ontology/contracts'
import type { ProjectRevision, ProjectStore, ProjectRecord, ProjectFactSourcePin, SemanticDefinitionVersion, ToolContext, VersionRef } from '@ontology/contracts'
import type { MaterializationPublishedSource, PublishedSemanticData, RuleFact } from '@ontology/semantic-engine'
import { CoreProjectSemanticPartitions } from '@ontology/app-api'
import { describe, expect, it, vi } from 'vitest'

const projectId = '11111111-1111-4111-8111-111111111111'
const documentId = '33333333-3333-4333-8333-333333333333'
const parseId = '44444444-4444-4444-8444-444444444444'
const digest1 = `sha256:${'1'.repeat(64)}`
const digest2 = `sha256:${'2'.repeat(64)}`
const scope = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
const readPoint = { semantic: '7', identity: '4' }
const ctx: ToolContext = createToolContext({
  principal: { tenantId: scope.tenantId, subjectId: 'partition-test', roles: [], scopes: [], authEpoch: 1 },
  runId: '55555555-5555-4555-8555-555555555555', resolvedProfileHash: digest1, policyVersion: '1.0.0',
  deadline: '2026-10-10T00:05:00Z', budgetReservation: { reservationId: '66666666-6666-4666-8666-666666666666', runId: '55555555-5555-4555-8555-555555555555', grantedAt: '2026-10-10T00:00:00Z', expiresAt: '2026-10-10T00:05:00Z' },
  allowedResources: { tenantId: scope.tenantId, spaceId: scope.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 100 },
  traceId: 'core-project-partition-test',
})

function definition(version: string, digest: string): SemanticDefinitionVersion {
  return {
    scopeRef: scope, definitionId: 'definition-a', version, namespace: 'test', layer: 'industry_core', standardProvenance: [],
    objects: [], attributes: [], relations: [], identityScopes: [], ruleConstraints: [],
    ref: { id: 'definition-a', version, digest }, publishedAt: '2026-10-10T00:00:00Z',
  }
}

function revision(number: string, definitionRef: VersionRef, purpose?: 'synthetic_validation'): ProjectRevision {
  const digest = number === '1' ? digest1 : digest2
  return {
    ref: { projectId, revision: number, digest },
    industryPackRef: { id: 'pack-a', version: '1.0.0', digest: digest1 }, definitionRef,
    mappingRefs: [{ id: 'mapping-a', version: '1.0.0', digest: digest1, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'import', sourceId: 'source-a' }, objectPath: 'row' } }],
    profileRef: { id: 'profile-a', version: '1.0.0', snapshotHash: digest1 },
    documentSetRef: { id: documentId, version: '1.0.0', digest: digest1, kind: 'artifact' },
    semanticPublicationRefs: [], sourceVisibilityEpoch: number, changeReason: 'test revision',
    ...(purpose === undefined ? {} : { executionPurpose: purpose }),
  }
}

function projectRecord(activeRevision: string, headRevision: string): ProjectRecord {
  return {
    projectId, title: 'Partition test', activeRevision, headRevision, state: 'active', createdBy: 'test',
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  }
}

function partition(sourceRevision: ProjectRevision, sourceDefinition: SemanticDefinitionVersion, factsCount = 1, revisionPins?: readonly ProjectRevision[]): PublishedSemanticData {
  const statements = Array.from({ length: factsCount }, (_, index) => {
    const entityId = `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`
    const pinnedRevision = revisionPins?.[index] ?? sourceRevision
    const pin: ProjectFactSourcePin = {
      projectRevisionRef: pinnedRevision.ref, definitionRef: sourceDefinition.ref, mappingRef: pinnedRevision.mappingRefs[0]!,
      recordId: entityId, recordRevision: '1', contentDigest: digest1, sourceDigest: digest1, sourceRecordedAt: '2026-10-10T00:00:00Z',
      documentId, parseId, membershipRevision: '1', visibilityEpoch: '1', entityCandidateId: entityId,
    }
    return {
      recordId: entityId,
      statementId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
      propositionKey: `entity:${index}`, kind: 'entity' as const, predicate: 'name', value: { provenance: { sources: [pin] } },
      recordedAt: '2026-10-10T00:00:00Z', sourceCandidateId: entityId,
      sourceRefs: [], publicationId: '88888888-8888-4888-8888-888888888888', version: '1', status: 'active' as const,
    }
  })
  const facts: RuleFact[] = statements.map((statement) => ({
    projectId, sourceStatementId: statement.statementId, assertionId: `assertion-${statement.statementId}`,
    logicalAssertionId: `logical-${statement.statementId}`, recordedSeq: '1', op: 'assert', subject: statement.recordId,
    predicate: 'name', value: 'Meter A', validity: { validFrom: '2026-10-10T00:00:00Z' },
    sourceRef: { namespace: 'import', sourceId: 'source-a' },
  }))
  return {
    facts, rules: [], entityBindings: [], definitionRef: sourceDefinition.ref, readRevision: readPoint,
    premiseInput: {
      definition: sourceDefinition, declarations: [], attributeStatements: statements, relationStatements: [], identityBindings: [],
      subjects: [], facts: [], completeRangeAttributeIds: [],
    },
    complete: true,
  }
}

async function loadPartitions(input: {
  readonly active: ProjectRevision
  readonly head: ProjectRevision
  readonly oldPart: PublishedSemanticData
  readonly historicalRevision?: ProjectRevision
}) {
  const revisions = new Map([[input.active.ref.revision, input.active], [input.head.ref.revision, input.head]])
  if (input.historicalRevision !== undefined) revisions.set(input.historicalRevision.ref.revision, input.historicalRevision)
  const projectStore: Pick<ProjectStore, 'getProject' | 'getRevision'> = {
    getProject: vi.fn(async () => projectRecord(input.active.ref.revision, input.head.ref.revision)),
    getRevision: vi.fn(async (_scope, _projectId, number) => revisions.get(number)),
  }
  const definitions = new Map([[input.active.definitionRef.digest, definition(input.active.definitionRef.version, input.active.definitionRef.digest)]])
  const source = vi.fn((revisionValue: ProjectRevision, definitionValue: SemanticDefinitionVersion): MaterializationPublishedSource => ({
    load: async () => partition(revisionValue, definitionValue),
  }))
  const base: MaterializationPublishedSource = {
    load: async () => ({ facts: [], rules: [], entityBindings: [], complete: true, readRevision: readPoint, partitions: [input.oldPart] }),
  }
  const materializer = new CoreProjectSemanticPartitions(base, {
    options: {
      projects: projectStore,
      definition: vi.fn(async (_scope, ref) => definitions.get(ref.digest)),
      source,
    },
  }, async () => [input.active])
  return { result: await materializer.load(scope, ctx), source }
}

describe('CoreProjectSemanticPartitions', () => {
  const definition1 = definition('1.0.0', digest1)
  const definition2 = definition('2.0.0', digest2)

  it('preserves a reviewed head P2 partition while active selectors remain P1', async () => {
    const { result, source } = await loadPartitions({ active: revision('1', definition1.ref), head: revision('2', definition2.ref), oldPart: partition(revision('2', definition2.ref), definition2, 2) })
    expect(result.complete).toBe(true)
    expect(result.partitions?.map((part) => part.definitionRef?.version ?? part.premiseInput?.definition?.version)).toEqual(['2.0.0', '1.0.0'])
    expect(source).toHaveBeenCalledTimes(1)
    expect(source.mock.calls[0]?.[0].ref).toEqual(revision('1', definition1.ref).ref)
  })

  it('preserves the P1 historical partition after P2 activation', async () => {
    const { result } = await loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: revision('1', definition1.ref), oldPart: partition(revision('1', definition1.ref), definition1) })
    expect(result.complete).toBe(true)
    expect(result.partitions?.map((part) => part.definitionRef?.version ?? part.premiseInput?.definition?.version)).toEqual(['1.0.0', '2.0.0'])
  })

  it('rejects a synthetic validation revision even when its project pins otherwise match', async () => {
    const synthetic = revision('1', definition1.ref, 'synthetic_validation')
    await expect(loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: synthetic, oldPart: partition(synthetic, definition1) }))
      .rejects.toThrow('a historical project partition has no exact authorized stored revision provenance')
  })

  it('does not let another valid fact pin mask a project fact without its exact statement', async () => {
    const oldPart = partition(revision('1', definition1.ref), definition1, 2)
    const altered: PublishedSemanticData = { ...oldPart, facts: [...oldPart.facts, { ...oldPart.facts[0]!, sourceStatementId: '99999999-9999-4999-8999-999999999999' }] }
    await expect(loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: revision('1', definition1.ref), oldPart: altered }))
      .rejects.toThrow('a historical project partition has no exact authorized stored revision provenance')
  })

  it('rejects a historical definition reference with a matching digest but a different identity', async () => {
    const sourcePart = partition(revision('1', definition1.ref), definition1)
    const forgedPart: PublishedSemanticData = { ...sourcePart, definitionRef: { ...definition1.ref, id: 'other-definition' } }
    await expect(loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: revision('1', definition1.ref), oldPart: forgedPart }))
      .rejects.toThrow('a historical project partition has no exact authorized stored revision provenance')
  })

  it('rejects a pinned revision beyond both the active revision and staged head', async () => {
    const future = revision('3', definition1.ref)
    await expect(loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: future, oldPart: partition(future, definition1) }))
      .rejects.toThrow('a historical project partition has no exact authorized stored revision provenance')
  })

  it('rejects unbounded historical revisions before issuing store reads', async () => {
    const pins = Array.from({ length: 33 }, (_, index) => revision(String(index + 1), definition1.ref))
    const oversized = partition(revision('1', definition1.ref), definition1, 33, pins)
    await expect(loadPartitions({ active: revision('2', definition2.ref), head: revision('2', definition2.ref), historicalRevision: revision('1', definition1.ref), oldPart: oversized }))
      .rejects.toThrow('a historical project partition has no exact authorized stored revision provenance')
  })
})
