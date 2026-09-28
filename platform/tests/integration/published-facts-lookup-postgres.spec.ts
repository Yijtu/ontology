import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { OntologyLookupHandler } from '@ontology/tool-services'
import type { ToolExecutionOutcome, ToolExecutionRequest } from '@ontology/tool-services'
import {
  InMemorySemanticDefinitionStore,
  OntologyLookupService,
  PublishedSemanticSource,
  SemanticDefinitionService,
  sha256DigestOf,
} from '@ontology/semantic-engine'
import type { OntologyLookupOutput } from '@ontology/contracts'
import type { OntologyFactQuery } from '@ontology/semantic-engine'
import type {
  NewOutboxMessage,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { PublishedFactsReferenceProvider } from '../../packages/semantic-engine/src/mapping/published-facts'
import { PUBLICATION_DEFINITION_REF } from '../unit/publication-fixtures'
import { RecordingControlRepository, toolContext } from '../unit/semantic-definition-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { FixturePublishedIdentityReader } from './published-identity-reader'

const PUBLISHED_AT = '2026-09-21T06:00:00Z'
const FACT_VALIDITY = { validFrom: '2026-09-20T00:00:00Z', validTo: '2026-10-01T00:00:00Z' }
const PAGE_SIZE = 200

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scopeRef: ScopeRef
let ctx: ToolContext
let jobId: Uuid
let publication: PostgresSemanticPublicationStore
let identity: FixturePublishedIdentityReader
let lookup: OntologyLookupService
let handler: OntologyLookupHandler

function sourceRefs(index: number): ResourceRef[] {
  return [{
    id: randomUUID(),
    version: '1.0.0',
    digest: sha256DigestOf({ source: 'published-facts-lookup', index }),
    kind: 'evidence',
  }]
}

function statementFor(publicationId: Uuid, index: number, subjectEntityId = randomUUID()): PublishedStatement {
  const statementId = randomUUID()
  return {
    statementId,
    propositionKey: `${subjectEntityId}.attributes`,
    kind: 'entity',
    objectId: 'device',
    subjectEntityId,
    predicate: 'device',
    value: {
      attributes: [{
        attributeId: 'operating_hours',
        value: String(index),
        unitCode: 'h',
      }],
    },
    validFrom: index === 1_001 ? '2026-09-25T00:00:00Z' : FACT_VALIDITY.validFrom,
    validTo: FACT_VALIDITY.validTo,
    recordedAt: PUBLISHED_AT,
    sourceCandidateId: randomUUID(),
    sourceRefs: sourceRefs(index),
    publicationId,
    version: '1',
    status: 'active',
  }
}

async function seedJob(prefix: string): Promise<Uuid> {
  const id = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', $4, $5, '1.0.0', 'published',
       $6, $7, 1, '{}'::jsonb, now(), now(), $8, now())`,
    [
      scopeRef.tenantId,
      scopeRef.spaceId,
      id,
      `${prefix}-source`,
      randomUUID(),
      `${prefix}-${id.slice(0, 8)}`,
      sha256DigestOf({ id }),
      prefix,
    ],
  )
  return id
}

async function publishStatements(
  statements: readonly PublishedStatement[],
  idempotencyKey: string,
  targetPublicationId = randomUUID(),
  targetJobId = jobId,
): Promise<Uuid> {
  const outbox: NewOutboxMessage = {
    outboxId: randomUUID(),
    topic: `test.${idempotencyKey}`,
    payload: { publicationId: targetPublicationId },
    idempotencyKey: `${idempotencyKey}:outbox`,
    availableAt: PUBLISHED_AT,
    createdAt: PUBLISHED_AT,
  }
  const expectedRevision = await publication.latestPublicationRevision(scopeRef, ctx)
  const publicationInput: PublishSemanticPublicationInput = {
    expectedRevision,
    publication: {
      publicationId: targetPublicationId,
      versionRef: { id: targetPublicationId, version: '1.0.0', digest: sha256DigestOf({ targetPublicationId }) },
      schemaRef: PUBLICATION_DEFINITION_REF,
      approvedCandidateRefs: [],
      statements: statements.map((statement) => ({ ...statement, publicationId: targetPublicationId })),
      ruleVersions: [],
      outboxId: outbox.outboxId,
      publishedAt: PUBLISHED_AT,
      actor: ctx.principal.subjectId,
    },
    idempotencyKey,
    requestDigest: sha256DigestOf({ idempotencyKey, statementIds: statements.map((statement) => statement.statementId) }),
    identityBindings: [],
    outbox,
    outboxJobId: targetJobId,
  }
  identity.bindStatements(statements)
  await publication.publish(scopeRef, publicationInput, ctx)
  return targetPublicationId
}

function requestOf(arguments_: Readonly<Record<string, unknown>>): ToolExecutionRequest {
  return {
    callId: randomUUID(),
    toolId: 'ontology_lookup',
    arguments: arguments_,
    resultLimits: { maxRows: PAGE_SIZE, maxBytes: 1_000_000, maxDurationMs: 30_000 },
    deadline: ctx.deadline,
    traceId: ctx.traceId,
    ctx,
    signal: new AbortController().signal,
  }
}

function outputOf(outcome: ToolExecutionOutcome): OntologyLookupOutput {
  if (typeof outcome.payload !== 'object' || outcome.payload === null || !('items' in outcome.payload)) {
    throw new Error('ontology_lookup did not return a lookup payload')
  }
  return outcome.payload as OntologyLookupOutput
}

beforeAll(async () => {
  harness = await startJobDatabase()
  const scope = await createJobScope(harness.adminClient, 'published-facts-lookup')
  scopeRef = scope.scopeRef
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  publication = new PostgresSemanticPublicationStore(database)
  identity = new FixturePublishedIdentityReader()
  jobId = await seedJob('published-facts-lookup')

  const source = new PublishedSemanticSource(publication, {
    identity,
    definitionRef: PUBLICATION_DEFINITION_REF,
    pageSize: 250,
    maxRecords: 2_000,
  })
  const definitions = new SemanticDefinitionService({
    store: new InMemorySemanticDefinitionStore(),
    control: new RecordingControlRepository(),
  })
  lookup = new OntologyLookupService({
    definitions,
    facts: new PublishedFactsReferenceProvider({
      source,
      namespace: 'home-energy',
      definitionRef: PUBLICATION_DEFINITION_REF,
      now: () => '2026-09-24T00:00:00Z',
    }),
    pageSize: PAGE_SIZE,
    maxPageSize: PAGE_SIZE,
  })
  handler = new OntologyLookupHandler({
    lookup,
    sourceRef: { namespace: 'platform', sourceId: 'published-semantic-facts' },
  })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('published ontology facts through the real PostgreSQL publication reader', () => {
  it('returns 1001 exact attribute instances over handler cursors without mixing same-attribute entities', async () => {
    const targetPublicationId = randomUUID()
    const statements = Array.from({ length: 1_002 }, (_, index) => statementFor(targetPublicationId, index + 1))
    await publishStatements(statements, 'published-facts-lookup-1001', targetPublicationId)

    const baseArguments = {
      scopeRef,
      intent: 'facts',
      concepts: [{ namespace: 'home-energy', conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
      limit: PAGE_SIZE,
    }
    const allSubjects = new Set<string>()
    let cursor: string | undefined
    let firstCursor: string | undefined
    let pageCount = 0
    do {
      const outcome = await handler.execute(requestOf({
        ...baseArguments,
        ...(cursor === undefined ? {} : { cursor }),
      }))
      const output = outputOf(outcome)
      expect(output.items.every((item) => item.kind === 'fact')).toBe(true)
      expect(output.items.every((item) => item.ref.version === '1.0.0')).toBe(true)
      expect(output.definitionVersion).toEqual(PUBLICATION_DEFINITION_REF)
      for (const item of output.items) {
        const payload = item.payload as { subjectEntityId: string; attributeId: string; sourceStatementId: string; value: { amount: string; unit: string } }
        expect(payload.attributeId).toBe('operating_hours')
        expect(payload.sourceStatementId).toBeDefined()
        expect(payload.value.unit).toBe('h')
        allSubjects.add(payload.subjectEntityId)
      }
      if (pageCount === 0) firstCursor = outcome.coverage.cursor
      cursor = outcome.coverage.cursor
      pageCount += 1
      expect(pageCount).toBeLessThanOrEqual(6)
      expect(outcome.coverage.completeness).toBe(outcome.coverage.truncated ? 'partial' : 'complete')
    } while (cursor !== undefined)
    expect(pageCount).toBe(6)
    expect(allSubjects.size).toBe(1_001)

    const afterSnapshot = statementFor(randomUUID(), 1_002)
    await publishStatements([afterSnapshot], 'published-facts-lookup-revision-change')
    if (firstCursor === undefined) throw new Error('first facts page did not return a continuation cursor')
    const staleContinuation = await handler.execute(requestOf({
      ...baseArguments,
      cursor: firstCursor,
    }))
    expect(staleContinuation.coverage.completeness).toBe('unknown')
    expect(outputOf(staleContinuation).items).toEqual([])
    expect(outputOf(staleContinuation).gaps.join(' ')).toMatch(/read revision changed/)

    const historicalLookup = await handler.execute(requestOf({
      ...baseArguments,
      timeContext: { asOf: '2026-09-20T00:00:00Z', validAt: '2026-09-24T00:00:00Z', timeZone: 'UTC' },
    }))
    expect(historicalLookup.coverage.completeness).toBe('unknown')
    expect(outputOf(historicalLookup).items).toEqual([])
    expect(outputOf(historicalLookup).gaps.join(' ')).toMatch(/no current-head fallback/)

    const entity = statements[0]?.subjectEntityId
    if (entity === undefined) throw new Error('published fact fixture is missing an entity')
    const scoped = await handler.execute(requestOf({
      ...baseArguments,
      entityRefs: [{ id: entity, version: '1.0.0', digest: sha256DigestOf({ entity }), kind: 'dataset' }],
    }))
    const scopedOutput = outputOf(scoped)
    expect(scopedOutput.items).toHaveLength(1)
    expect((scopedOutput.items[0]?.payload as { subjectEntityId: string }).subjectEntityId).toBe(entity)

    const validAt = await new PublishedFactsReferenceProvider({
      source: new PublishedSemanticSource(publication, { identity, definitionRef: PUBLICATION_DEFINITION_REF, pageSize: 250, maxRecords: 2_000 }),
      namespace: 'home-energy',
      definitionRef: PUBLICATION_DEFINITION_REF,
      now: () => '2026-09-24T00:00:00Z',
    }).listFacts({
      scopeRef,
      concepts: [{ namespace: 'home-energy', conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
      entityRefs: [],
      limit: 2_000,
      validAt: '2026-09-24T00:00:00Z',
    }, ctx)
    expect(validAt.covered).toBe(true)
    expect(validAt.facts).toHaveLength(1_002)
    expect(validAt.facts.some((fact) => fact.payload && (fact.payload as { sourceStatementId: string }).sourceStatementId === statements[1_000]?.statementId)).toBe(false)

    const withdrawn = statements[0]
    if (withdrawn === undefined || withdrawn.subjectEntityId === undefined) {
      throw new Error('published attribute fixture is missing its first statement')
    }
    const revisionId = randomUUID()
    await publication.reviseStatement(scopeRef, {
      expectedRevision: '1',
      revisionId,
      statementId: withdrawn.statementId,
      kind: 'retraction',
      reason: 'verify withdrawn property is not presented as a current fact',
      recordedAt: '2026-09-24T12:00:00Z',
      actor: ctx.principal.subjectId,
      outbox: {
        outboxId: randomUUID(),
        topic: 'test.published-fact-retraction',
        payload: { statementId: withdrawn.statementId, revisionId, kind: 'retraction' },
        idempotencyKey: `published-fact-retraction:${withdrawn.statementId}`,
        availableAt: '2026-09-24T12:00:00Z',
        createdAt: '2026-09-24T12:00:00Z',
      },
    }, ctx)
    const afterRetraction = await new PublishedFactsReferenceProvider({
      source: new PublishedSemanticSource(publication, { identity, definitionRef: PUBLICATION_DEFINITION_REF, pageSize: 250, maxRecords: 2_000 }),
      namespace: 'home-energy',
      definitionRef: PUBLICATION_DEFINITION_REF,
      now: () => '2026-09-24T12:00:00Z',
    }).listFacts({
      scopeRef,
      concepts: [{ namespace: 'home-energy', conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
      entityRefs: [{ id: withdrawn.subjectEntityId, version: '1.0.0', digest: sha256DigestOf({ subject: withdrawn.subjectEntityId }), kind: 'dataset' }],
      limit: 10,
    }, ctx)
    expect(afterRetraction.covered).toBe(true)
    expect(afterRetraction.facts).toEqual([])
  })

  it('does not convert latest facts into historical answers or claim coverage when identity is incomplete', async () => {
    const targetPublicationId = randomUUID()
    const unboundStatement = statementFor(targetPublicationId, 1)
    const invalidScope = await createJobScope(harness.adminClient, 'published-facts-unbound')
    const invalidCtx = toolContext(invalidScope.tenantId, invalidScope.spaceId, ['semantic-publisher', 'platform-admin'])
    const invalidJobId = await (async () => {
      const id = randomUUID()
      await harness.adminClient.query(
        `INSERT INTO agent_platform.jobs (
           tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
           idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
         VALUES ($1, $2, $3, 'ingestion', $4, $5, '1.0.0', 'published', $6, $7, 1, '{}'::jsonb, now(), now(), $8, now())`,
        [invalidScope.tenantId, invalidScope.spaceId, id, 'unbound-source', randomUUID(), `unbound-${id.slice(0, 8)}`, sha256DigestOf({ id }), 'published-facts-test'],
      )
      return id
    })()
    const invalidPublicationId = randomUUID()
    const invalidOutbox: NewOutboxMessage = {
      outboxId: randomUUID(),
      topic: 'test.unbound-publication',
      payload: { publicationId: invalidPublicationId },
      idempotencyKey: `unbound-publication:${invalidPublicationId}`,
      availableAt: PUBLISHED_AT,
      createdAt: PUBLISHED_AT,
    }
    const invalidExpectedRevision = await publication.latestPublicationRevision(invalidScope.scopeRef, invalidCtx)
    await publication.publish(invalidScope.scopeRef, {
      expectedRevision: invalidExpectedRevision,
      publication: {
        publicationId: invalidPublicationId,
        versionRef: { id: invalidPublicationId, version: '1.0.0', digest: sha256DigestOf({ invalidPublicationId }) },
        schemaRef: PUBLICATION_DEFINITION_REF,
        approvedCandidateRefs: [],
        statements: [{ ...unboundStatement, publicationId: invalidPublicationId }],
        ruleVersions: [],
        outboxId: invalidOutbox.outboxId,
        publishedAt: PUBLISHED_AT,
        actor: invalidCtx.principal.subjectId,
      },
      idempotencyKey: 'unbound-facts-publication',
      requestDigest: sha256DigestOf({ unbound: invalidPublicationId }),
      identityBindings: [],
      outbox: invalidOutbox,
      outboxJobId: invalidJobId,
    }, invalidCtx)

    const source = new PublishedSemanticSource(publication, {
      identity: new FixturePublishedIdentityReader(),
      definitionRef: PUBLICATION_DEFINITION_REF,
    })
    const provider = new PublishedFactsReferenceProvider({ source, namespace: 'home-energy', definitionRef: PUBLICATION_DEFINITION_REF, now: () => '2026-09-24T00:00:00Z' })
    const query: OntologyFactQuery = {
      scopeRef: invalidScope.scopeRef,
      concepts: [{ namespace: 'home-energy', conceptId: 'operating_hours', definitionVersion: '1.0.0' }],
      entityRefs: [],
      limit: 100,
    }
    const incompleteIdentity = await provider.listFacts(query, invalidCtx)
    expect(incompleteIdentity.covered).toBe(false)
    expect(incompleteIdentity.facts).toEqual([])
    expect(incompleteIdentity.issues?.join(' ')).toMatch(/PUBLISHED_IDENTITY_UNCONFIRMED/)

    const historical = await provider.listFacts({
      ...query,
      timeContext: { asOf: '2026-09-20T00:00:00Z', timeZone: 'UTC', validAt: FACT_VALIDITY.validFrom },
    }, invalidCtx)
    expect(historical.covered).toBe(false)
    expect(historical.facts).toEqual([])
    expect(historical.issues?.join(' ')).toMatch(/no current-head fallback/)
  })
})
