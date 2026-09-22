import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryCandidateStore, InMemoryIndustrySchemaSource } from '@ontology/application'
import {
  IdentityDecisionService,
  InMemoryIdentityDecisionStore,
  InMemorySemanticPublicationStore,
  SemanticPublicationService,
} from '@ontology/semantic-engine'
import type { CandidateRecord, SemanticPublicationVersion } from '@ontology/contracts'
import { SPACE_A, TENANT_A, toolContext } from './component-registry-fixtures'
import {
  PUBLICATION_DEFINITION_REF,
  entityFor,
  publicationSchema,
  ruleFor,
  unhandledRuleFor,
} from './publication-fixtures'

const scopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const ctx = toolContext(TENANT_A, SPACE_A, ['semantic-reviewer', 'semantic-publisher', 'platform-admin'])

let candidates: InMemoryCandidateStore
let identityStore: InMemoryIdentityDecisionStore
let publicationStore: InMemorySemanticPublicationStore
let identityService: IdentityDecisionService
let service: SemanticPublicationService

beforeEach(() => {
  candidates = new InMemoryCandidateStore()
  identityStore = new InMemoryIdentityDecisionStore()
  publicationStore = new InMemorySemanticPublicationStore()
  identityService = new IdentityDecisionService({
    store: identityStore,
    candidates,
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
    ]),
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  service = new SemanticPublicationService({
    store: publicationStore,
    candidates,
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: PUBLICATION_DEFINITION_REF, schema: publicationSchema(PUBLICATION_DEFINITION_REF) },
    ]),
    identity: identityStore,
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
})

function idempotencyKey(): string {
  return `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`
}

async function insert(candidate: CandidateRecord): Promise<void> {
  await candidates.insertCandidates(scopeRef, [candidate], ctx)
}

async function createEntity(candidateId: string): Promise<string> {
  const view = await identityService.decide({ candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx)
  if (view.targetEntityId === undefined) throw new Error('create_pending returned no entity')
  return view.targetEntityId
}

async function matchEntity(candidateId: string, entityId: string, expectedRevision = '0'): Promise<void> {
  await identityService.decide(
    {
      candidateId,
      kind: 'match',
      expectedRevision,
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', value: `N-${candidateId}` },
    },
    ctx,
  )
}

async function approve(candidateId: string, expectedRevision = '0'): Promise<void> {
  await service.reviewCandidate(
    { candidateId, decision: 'approve', reason: 'source verified', expectedRevision },
    ctx,
  )
}

async function publish(
  refs: readonly { readonly candidateId: string; readonly kind: CandidateRecord['kind'] }[],
  key: string,
  expectedRevision = '0',
): Promise<SemanticPublicationVersion> {
  return service.publish(
    { approvedCandidateRefs: refs, schemaRef: PUBLICATION_DEFINITION_REF, expectedRevision, idempotencyKey: key },
    ctx,
  )
}

/** Seed a `device` entity candidate with a resolved (matched) identity. */
async function seedApprovedEntity(): Promise<{
  candidateId: string
  entityId: string
}> {
  const candidateId = randomUUID()
  await insert(entityFor({ candidateId, idempotencyKey: idempotencyKey() }))
  const entityId = await createEntity(candidateId)
  await matchEntity(candidateId, entityId, '1')
  await approve(candidateId)
  return { candidateId, entityId }
}

describe('semantic publication service (in-memory)', () => {
  it('publishes only approved candidates and keeps the candidate and published read views separate', async () => {
    const first = await seedApprovedEntity()
    const secondCandidate = randomUUID()
    await insert(entityFor({ candidateId: secondCandidate, idempotencyKey: idempotencyKey() }))
    await matchEntity(secondCandidate, first.entityId)
    await approve(secondCandidate)

    const unapproved = randomUUID()
    await insert(entityFor({ candidateId: unapproved, idempotencyKey: idempotencyKey() }))
    await createEntity(unapproved)

    const publication = await publish(
      [
        { candidateId: first.candidateId, kind: 'entity' },
        { candidateId: secondCandidate, kind: 'entity' },
      ],
      'pub-separation',
    )
    expect(publication.statements).toHaveLength(2)

    const published = await service.listStatements({}, ctx)
    expect(published.map((statement) => statement.statementId).sort()).toEqual(
      [first.candidateId, secondCandidate].sort(),
    )
    // The unapproved candidate is structurally absent from the published read view...
    await expect(service.getStatement(unapproved, ctx)).rejects.toMatchObject({ code: 'STATEMENT_NOT_FOUND' })
    // ...but still exists in the candidate store, so the two views are genuinely separate.
    expect(await candidates.getCandidate(scopeRef, unapproved, ctx)).toBeDefined()

    await expect(publish([{ candidateId: unapproved, kind: 'entity' }], 'pub-unapproved')).rejects.toMatchObject({
      code: 'CANDIDATE_NOT_APPROVED',
    })
  })

  it('refuses a failed, rejected, unrepresentable or conflicted candidate with a specific reason', async () => {
    const failed = randomUUID()
    await insert(
      entityFor({
        candidateId: failed,
        idempotencyKey: idempotencyKey(),
        state: 'failed',
        issues: [{ code: 'TYPE_MISMATCH', message: 'value is not a string' }],
      }),
    )
    await approve(failed)
    await expect(publish([{ candidateId: failed, kind: 'entity' }], 'pub-failed')).rejects.toMatchObject({
      code: 'CANDIDATE_FAILED',
      reasons: [{ code: 'TYPE_MISMATCH' }],
    })

    const rejected = randomUUID()
    await insert(entityFor({ candidateId: rejected, idempotencyKey: idempotencyKey(), state: 'rejected' }))
    await approve(rejected)
    await expect(publish([{ candidateId: rejected, kind: 'entity' }], 'pub-rejected')).rejects.toMatchObject({
      code: 'CANDIDATE_REJECTED',
    })

    const unhandled = randomUUID()
    await insert(unhandledRuleFor({ candidateId: unhandled, idempotencyKey: idempotencyKey() }))
    await approve(unhandled)
    await expect(publish([{ candidateId: unhandled, kind: 'rule_unhandled' }], 'pub-unhandled')).rejects.toMatchObject({
      code: 'CANDIDATE_UNREPRESENTABLE',
    })

    const conflicted = randomUUID()
    await insert(
      ruleFor({
        candidateId: conflicted,
        idempotencyKey: idempotencyKey(),
        conflicts: [
          { withRuleId: 'other', withCandidateId: randomUUID(), attributeId: 'device_name', reason: 'contradiction' },
        ],
      }),
    )
    await approve(conflicted)
    await expect(publish([{ candidateId: conflicted, kind: 'rule' }], 'pub-conflict')).rejects.toMatchObject({
      code: 'CANDIDATE_CONFLICTED',
      reasons: [{ code: 'CONFLICTING_RULE' }],
    })
  })

  it('refuses a bad source, a schema mismatch and an unresolved identity with a specific reason', async () => {
    const noSource = randomUUID()
    await insert(entityFor({ candidateId: noSource, idempotencyKey: idempotencyKey(), sourceSpans: [] }))
    await approve(noSource)
    await expect(publish([{ candidateId: noSource, kind: 'entity' }], 'pub-nosource')).rejects.toMatchObject({
      code: 'MISSING_SOURCE',
    })

    const wrongSchema = randomUUID()
    await insert(
      entityFor({
        candidateId: wrongSchema,
        idempotencyKey: idempotencyKey(),
        inputVersion: {
          definitionRef: { id: 'other.core', version: '2.0.0', digest: `sha256:${'e'.repeat(64)}` },
          parseId: '99999999-9999-4999-8999-999999999999',
          parserVersion: '1.0.0',
          pipelineVersion: '1.0.0',
        },
      }),
    )
    await approve(wrongSchema)
    await expect(publish([{ candidateId: wrongSchema, kind: 'entity' }], 'pub-schema')).rejects.toMatchObject({
      code: 'SCHEMA_MISMATCH',
    })

    const unresolved = randomUUID()
    await insert(entityFor({ candidateId: unresolved, idempotencyKey: idempotencyKey() }))
    await approve(unresolved)
    await expect(publish([{ candidateId: unresolved, kind: 'entity' }], 'pub-identity')).rejects.toMatchObject({
      code: 'IDENTITY_UNRESOLVED',
    })
  })

  it('publishes a representable rule candidate as a versioned rule', async () => {
    const candidateId = randomUUID()
    await insert(ruleFor({ candidateId, idempotencyKey: idempotencyKey() }))
    await approve(candidateId)
    const publication = await publish([{ candidateId, kind: 'rule' }], 'pub-rule')
    expect(publication.ruleVersions).toHaveLength(1)
    expect(publication.ruleVersions[0]?.ruleId).toBe('device_power_limit')
    const rules = await service.listRuleVersions({}, ctx)
    expect(rules).toHaveLength(1)
  })

  it('requires If-Match and rejects a stale publication head with a version conflict', async () => {
    const first = await seedApprovedEntity()
    await expect(
      service.publish(
        {
          approvedCandidateRefs: [{ candidateId: first.candidateId, kind: 'entity' }],
          schemaRef: PUBLICATION_DEFINITION_REF,
          expectedRevision: undefined,
          idempotencyKey: 'pub-missing',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })

    await expect(publish([{ candidateId: first.candidateId, kind: 'entity' }], 'pub-stale', '9')).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    })
  })

  it('does not publish twice when the same idempotency key is retried', async () => {
    const first = await seedApprovedEntity()
    const refs = [{ candidateId: first.candidateId, kind: 'entity' }] as const
    const original = await publish(refs, 'pub-retry')
    const replay = await publish(refs, 'pub-retry')
    expect(replay.publicationId).toBe(original.publicationId)
    expect(await publicationStore.latestPublicationRevision(scopeRef, ctx)).toBe('1')
    expect(await service.listStatements({}, ctx)).toHaveLength(1)
    expect(publicationStore.outboxMessages(scopeRef)).toHaveLength(1)
  })

  it('rejects a reused idempotency key with a different payload', async () => {
    const first = await seedApprovedEntity()
    const second = await seedApprovedEntity()
    await publish([{ candidateId: first.candidateId, kind: 'entity' }], 'pub-conflict-key')
    await expect(
      publish([{ candidateId: second.candidateId, kind: 'entity' }], 'pub-conflict-key', '1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('blocks a publication when the identity constraint check fails inside the transaction', async () => {
    const first = await seedApprovedEntity()
    publicationStore.blockIdentity(scopeRef, first.candidateId, first.entityId)
    await expect(publish([{ candidateId: first.candidateId, kind: 'entity' }], 'pub-blocked')).rejects.toMatchObject({
      code: 'IDENTITY_CONSTRAINT_BLOCKED',
    })
    expect(await publicationStore.latestPublicationRevision(scopeRef, ctx)).toBe('0')
    expect(await service.listStatements({}, ctx)).toHaveLength(0)
  })

  it('records a review decision and reads it back with its reason', async () => {
    const candidateId = randomUUID()
    await insert(entityFor({ candidateId, idempotencyKey: idempotencyKey() }))
    await service.reviewCandidate(
      { candidateId, decision: 'reject', reason: 'source is not authoritative', expectedRevision: '0' },
      ctx,
    )
    const history = await service.listReviews(candidateId, ctx)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ decision: 'reject', reason: 'source is not authoritative', revision: '1' })
    const readBack = await service.getReview(candidateId, '1', ctx)
    expect(readBack.reason).toBe('source is not authoritative')

    await expect(
      service.reviewCandidate({ candidateId, decision: 'approve', reason: 'second look', expectedRevision: undefined }, ctx),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
    await expect(
      service.reviewCandidate({ candidateId, decision: 'approve', reason: 'second look', expectedRevision: '0' }, ctx),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('preserves history on a retraction and keeps a conclusion another statement still supports', async () => {
    const first = randomUUID()
    const second = randomUUID()
    await insert(
      entityFor({
        candidateId: first,
        idempotencyKey: idempotencyKey(),
        attributes: [{ attributeId: 'device_name', value: 'Charger One' }],
      }),
    )
    await insert(
      entityFor({
        candidateId: second,
        idempotencyKey: idempotencyKey(),
        attributes: [{ attributeId: 'device_name', value: 'Charger One' }],
      }),
    )
    const entityId = await createEntity(first)
    await matchEntity(first, entityId, '1')
    await matchEntity(second, entityId)
    await approve(first)
    await approve(second)
    await publish(
      [
        { candidateId: first, kind: 'entity' },
        { candidateId: second, kind: 'entity' },
      ],
      'pub-revision',
    )

    const propositionKey = (await service.getStatement(first, ctx)).propositionKey
    expect((await service.getStatement(second, ctx)).propositionKey).toBe(propositionKey)

    const retraction = await service.reviseStatement(
      { statementId: first, kind: 'retraction', reason: 'source withdrawn', expectedRevision: '1', idempotencyKey: 'rev-1' },
      ctx,
    )
    expect(retraction.version).toBe('2')
    expect((await service.getStatement(first, ctx)).status).toBe('retracted')
    const history = await service.listStatementRevisions(first, ctx)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ kind: 'retraction', supersedesVersion: '1' })

    const supported = await service.getPropositionView(propositionKey, ctx)
    expect(supported.status).toBe('supported')
    expect(supported.activeStatements.map((statement) => statement.statementId)).toEqual([second])

    await service.reviseStatement(
      { statementId: second, kind: 'retraction', reason: 'last source withdrawn', expectedRevision: '1', idempotencyKey: 'rev-2' },
      ctx,
    )
    expect((await service.getPropositionView(propositionKey, ctx)).status).toBe('withdrawn')

    const topics = publicationStore.outboxMessages(scopeRef).map((message) => message.topic)
    expect(topics.filter((topic) => topic === 'semantic.statement.retracted')).toHaveLength(2)
  })
})
