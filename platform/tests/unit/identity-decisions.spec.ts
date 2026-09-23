import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryCandidateStore, InMemoryIndustrySchemaSource } from '@ontology/application'
import { IdentityDecisionService, InMemoryIdentityDecisionStore } from '@ontology/semantic-engine'
import type { IdentityDecisionRequest } from '@ontology/semantic-engine'
import type { EntityCandidate, IdentityDecisionDraft, IndustrySchema, ScopeRef, VersionRef } from '@ontology/contracts'
import { entityCandidate, IDENTITY_DEFINITION_REF } from './identity-fixtures'
import { toolContext } from './component-registry-fixtures'

const CTX = toolContext(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ['semantic-reviewer'],
)
const SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const JOB_ID = '88888888-8888-4888-8888-888888888888'

/** A definition with a `device` and a `sensor` object whose names can collide. */
function decisionSchema(ref: VersionRef): IndustrySchema {
  return {
    namespace: 'home-energy',
    definitionRef: ref,
    objects: [
      {
        objectId: 'device',
        displayName: 'Device',
        identityScopeId: 'device_identity',
        attributes: [
          { attributeId: 'device_native_id', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'device_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
          { attributeId: 'site', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: false },
        ],
      },
      {
        objectId: 'sensor',
        displayName: 'Sensor',
        identityScopeId: 'sensor_identity',
        attributes: [
          { attributeId: 'sensor_native_id', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'sensor_name', valueType: 'string', minCardinality: 0, maxCardinality: 1, identityKey: false },
          { attributeId: 'site', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: false },
        ],
      },
    ],
    relations: [],
    identityScopes: [
      { identityScopeId: 'device_identity', objectId: 'device', scopeDimensions: ['site'], identityAttributeIds: ['device_native_id'] },
      { identityScopeId: 'sensor_identity', objectId: 'sensor', scopeDimensions: ['site'], identityAttributeIds: ['sensor_native_id'] },
    ],
  }
}

interface Harness {
  readonly service: IdentityDecisionService
  readonly candidates: InMemoryCandidateStore
  readonly store: InMemoryIdentityDecisionStore
}

async function harness(): Promise<Harness> {
  const candidates = new InMemoryCandidateStore()
  const store = new InMemoryIdentityDecisionStore(() => randomUUID())
  const service = new IdentityDecisionService({
    store,
    candidates,
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: IDENTITY_DEFINITION_REF, schema: decisionSchema(IDENTITY_DEFINITION_REF) },
    ]),
    now: () => '2026-09-22T00:00:00Z',
    newId: () => randomUUID(),
  })
  return { service, candidates, store }
}

function deviceCandidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  const candidate: EntityCandidate = {
    ...entityCandidate({
      candidateId: randomUUID(),
      jobId: JOB_ID,
      idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
    }),
    ...overrides,
  }
  return { ...candidate, attributes: candidate.attributes.some((attribute) => attribute.attributeId === 'site')
    ? candidate.attributes : [...candidate.attributes, { attributeId: 'site', value: 'north-yard' }] }
}

function sensorCandidate(): EntityCandidate {
  return {
    ...deviceCandidate(),
    objectId: 'sensor',
    identityScopeId: 'sensor_identity',
    attributes: [{ attributeId: 'sensor_name', value: 'Shared Name' }],
  }
}

async function seed(candidates: InMemoryCandidateStore, candidate: EntityCandidate): Promise<void> {
  await candidates.insertCandidates(SCOPE, [candidate], CTX)
}

function decide(
  service: IdentityDecisionService,
  candidate: EntityCandidate,
  overrides: Partial<IdentityDecisionRequest> = {},
): Promise<Awaited<ReturnType<IdentityDecisionService['decide']>>> {
  return service.decide(
    {
      candidateId: candidate.candidateId,
      kind: 'create_pending',
      expectedRevision: '0',
      ...overrides,
    },
    CTX,
  )
}

describe('IdentityDecisionService unit behaviour', () => {
  it('creates a pending entity and appends revisions without overwriting history', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)

    const created = await decide(service, candidate, { kind: 'create_pending' })
    expect(created.kind).toBe('create_pending')
    expect(created.revision).toBe('1')
    expect(created.entity?.state).toBe('pending')

    const entityId = created.targetEntityId
    expect(entityId).toBeDefined()
    if (entityId === undefined) throw new Error('expected a created entity')

    const matched = await decide(service, candidate, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', value: 'DEV-1' },
    })
    expect(matched.kind).toBe('match')
    expect(matched.revision).toBe('2')
    expect(matched.supersedesRevision).toBe('1')

    // The previous revision stays readable and unchanged.
    const history = await service.listDecisionHistory(candidate.candidateId, {}, CTX)
    expect(history.map((entry) => entry.revision)).toEqual(['1', '2'])
    expect(history[0]?.kind).toBe('create_pending')
    expect(history[0]?.entity).toBeUndefined()

    const revisionOne = await service.getDecision(candidate.candidateId, '1', CTX)
    expect(revisionOne.kind).toBe('create_pending')
  })

  it('requires If-Match and rejects a stale revision', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)

    await expect(decide(service, candidate, { expectedRevision: undefined })).rejects.toMatchObject({
      code: 'REVISION_REQUIRED',
      httpStatus: 428,
    })

    await decide(service, candidate, { kind: 'create_pending' })
    await expect(decide(service, candidate, { kind: 'clarify', expectedRevision: '0' })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      httpStatus: 409,
    })
  })

  it('never merges on a model score alone, even a high one', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    await expect(
      decide(service, candidate, {
        kind: 'match',
        expectedRevision: '1',
        targetEntityId: entityId,
        scoreEvidence: {
          score: 0.99,
          backendRef: { id: 'similarity', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` },
        },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })
  })

  it('refuses a below-threshold score as support', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    await expect(
      decide(service, candidate, {
        kind: 'match',
        expectedRevision: '1',
        targetEntityId: entityId,
        scoreEvidence: {
          score: 0.2,
          backendRef: { id: 'similarity', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` },
        },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_SCORE_BELOW_THRESHOLD', httpStatus: 422 })
  })

  it('merges with a human justification even without a native id', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    const matched = await decide(service, candidate, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      justification: 'Reviewed the meter serial number in the source document.',
    })
    expect(matched.kind).toBe('match')
    expect(matched.revision).toBe('2')
  })

  it('blocks a merge with a cannot-link constraint recorded by a reject', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    const rejected = await decide(service, candidate, {
      kind: 'reject',
      expectedRevision: '1',
      targetEntityId: entityId,
    })
    expect(rejected.revision).toBe('2')

    await expect(
      decide(service, candidate, {
        kind: 'match',
        expectedRevision: '2',
        targetEntityId: entityId,
        strongIdentity: { kind: 'native_id', value: 'DEV-1' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT', httpStatus: 409 })
  })

  it('requires a split before rejecting a currently merged candidate against its own entity', async () => {
    const { service, candidates, store } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, candidate, {
      kind: 'match', expectedRevision: '1', targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', value: 'DEV-1' },
    })

    await expect(decide(service, candidate, {
      kind: 'reject', expectedRevision: '2', targetEntityId: entityId,
    })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT', httpStatus: 409 })
    expect(await store.listAssertions(SCOPE, { candidateId: candidate.candidateId, openOnly: true }, CTX)).toHaveLength(1)
    expect(await store.listLinkConstraints(SCOPE, candidate.candidateId, CTX)).toHaveLength(0)
  })

  it('checks native identity against both the candidate and the target cluster', async () => {
    const { service, candidates, store } = await harness()
    const anchor = deviceCandidate()
    await seed(candidates, anchor)
    const created = await decide(service, anchor, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, anchor, { kind: 'match', expectedRevision: '1', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } })

    const different = deviceCandidate({ attributes: [{ attributeId: 'device_native_id', value: 'DEV-2' }] })
    await seed(candidates, different)
    await expect(decide(service, different, { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-2' } })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    await expect(decide(service, different, { kind: 'match', targetEntityId: entityId, justification: 'reviewer believes these are the same' })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    await expect(decide(service, different, { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } })).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    expect(await store.listAssertions(SCOPE, { entityId, openOnly: true }, CTX)).toHaveLength(1)

    const same = deviceCandidate()
    await seed(candidates, same)
    const matched = await decide(service, same, { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } })
    expect(matched.kind).toBe('match')
    expect(await store.listAssertions(SCOPE, { entityId, openOnly: true }, CTX)).toHaveLength(2)

    const otherSite = deviceCandidate({ attributes: [
      { attributeId: 'device_native_id', value: 'DEV-1' }, { attributeId: 'site', value: 'south-yard' },
    ] })
    await seed(candidates, otherSite)
    await expect(decide(service, otherSite, { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } })).rejects.toMatchObject({ code: 'IDENTITY_SCOPE_MISMATCH' })
  })

  it('does not treat an unverified alias or a low score as merge authority', async () => {
    const { service, candidates } = await harness()
    const anchor = deviceCandidate()
    await seed(candidates, anchor)
    const created = await decide(service, anchor, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    const next = deviceCandidate()
    await seed(candidates, next)
    await expect(decide(service, next, { kind: 'match', targetEntityId: entityId, strongIdentity: { kind: 'confirmed_alias', value: 'Charger One' } })).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })
    await expect(decide(service, next, {
      kind: 'match', targetEntityId: entityId, justification: 'reviewed source identity',
      scoreEvidence: { score: 0.1, backendRef: { id: 'similarity', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` } },
    })).rejects.toMatchObject({ code: 'IDENTITY_SCORE_BELOW_THRESHOLD' })
  })

  it('keeps a reviewed justification distinct from an unverified automatic native-id match', async () => {
    const { service, candidates } = await harness()
    const anchor = deviceCandidate()
    await seed(candidates, anchor)
    const created = await decide(service, anchor, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    const candidate = deviceCandidate({ nativeId: 'DEV-2', attributes: [{ attributeId: 'device_native_id', value: 'DEV-2' }] })
    await seed(candidates, candidate)
    await expect(decide(service, candidate, { kind: 'match', targetEntityId: entityId })).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })
    const reviewed = await decide(service, candidate, { kind: 'match', targetEntityId: entityId, justification: 'reviewed the original span and the operator SQL key against this empty target' })
    expect(reviewed.kind).toBe('match')
  })

  it('uses an entity revision to reject a stale cluster update from another candidate', async () => {
    const { service, candidates, store } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, candidate, { kind: 'match', expectedRevision: '1', targetEntityId: entityId, strongIdentity: { kind: 'native_id', value: 'DEV-1' } })
    expect((await store.getEntity(SCOPE, entityId, CTX))?.revision).toBe('2')

    const other = deviceCandidate()
    await seed(candidates, other)
    const draft: IdentityDecisionDraft = {
      decisionId: randomUUID(), candidateId: other.candidateId, objectId: 'device', identityScopeId: 'device_identity',
      kind: 'clarify', targetEntityId: entityId, evidenceRefs: [], recordedAt: '2026-09-22T00:00:00Z', actor: 'reviewer',
    }
    await expect(store.appendDecision(SCOPE, { expectedRevision: '0', expectedEntityRevision: '1', draft }, CTX)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await store.latestRevision(SCOPE, other.candidateId, CTX)).toBe('0')
    expect((await store.getEntity(SCOPE, entityId, CTX))?.revision).toBe('2')
  })

  it('never merges a device and a sensor that share a display name', async () => {
    const { service, candidates } = await harness()
    const device = deviceCandidate()
    await seed(candidates, device)
    const created = await decide(service, device, { kind: 'create_pending' })
    const deviceEntityId = created.targetEntityId
    if (deviceEntityId === undefined) throw new Error('expected a created entity')

    const sensor = sensorCandidate()
    await seed(candidates, sensor)
    await expect(
      decide(service, sensor, {
        kind: 'match',
        expectedRevision: '0',
        targetEntityId: deviceEntityId,
        strongIdentity: { kind: 'native_id', value: 'SNS-1' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_SCOPE_MISMATCH', httpStatus: 409 })
  })

  it('separates sources on a split and emits a downstream invalidation', async () => {
    const { service, candidates, store } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, candidate, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', value: 'DEV-1' },
    })
    expect(await store.listAssertions(SCOPE, { entityId, openOnly: true }, CTX)).toHaveLength(1)

    const split = await decide(service, candidate, {
      kind: 'split',
      expectedRevision: '2',
      targetEntityId: entityId,
      justification: 'the merge was wrong',
    })
    expect(split.kind).toBe('split')
    expect(split.invalidationOutboxId).toBeDefined()
    // The open assertion is closed, not deleted.
    expect(await store.listAssertions(SCOPE, { entityId, openOnly: true }, CTX)).toHaveLength(0)
    const all = await store.listAssertions(SCOPE, { entityId }, CTX)
    expect(all).toHaveLength(1)
    expect(all[0]?.validTo).toBeDefined()
    // History is preserved across the reversal.
    const history = await service.listDecisionHistory(candidate.candidateId, {}, CTX)
    expect(history.map((entry) => entry.kind)).toEqual(['create_pending', 'match', 'split'])
  })

  it('serialises concurrent decisions with the same expected revision', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)

    const results = await Promise.allSettled([
      decide(service, candidate, { kind: 'clarify', expectedRevision: '0' }),
      decide(service, candidate, { kind: 'clarify', expectedRevision: '0' }),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const failure = rejected[0]
    expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({
      code: 'VERSION_CONFLICT',
    })
  })
})
