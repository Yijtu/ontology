import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryCandidateStore, InMemoryIndustrySchemaSource } from '@ontology/application'
import { IdentityDecisionService, InMemoryIdentityDecisionStore } from '@ontology/semantic-engine'
import type { IdentityDecisionRequest } from '@ontology/semantic-engine'
import type { AppendIdentityDecisionInput, EntityCandidate, IndustrySchema, ScopeRef, VersionRef } from '@ontology/contracts'
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
  const base = entityCandidate({
    candidateId: randomUUID(),
    jobId: JOB_ID,
    idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`,
  })
  return {
    ...base,
    ...overrides,
    attributes: overrides.attributes ?? [...base.attributes, { attributeId: 'site', value: 'site-a' }],
  }
}

function sensorCandidate(): EntityCandidate {
  return {
    ...deviceCandidate(),
    objectId: 'sensor',
    identityScopeId: 'sensor_identity',
    attributes: [
      { attributeId: 'sensor_native_id', value: 'SNS-1' },
      { attributeId: 'sensor_name', value: 'Shared Name' },
      { attributeId: 'site', value: 'site-a' },
    ],
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
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
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

  it('does not auto-promote an unreviewed native id and rejects forged identity evidence', async () => {
    const { service, candidates } = await harness()
    const candidate = deviceCandidate({ nativeId: 'UNREVIEWED-1' })
    await seed(candidates, candidate)
    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    await expect(
      decide(service, candidate, { kind: 'match', expectedRevision: '1', targetEntityId: entityId }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })

    await expect(
      decide(service, candidate, {
        kind: 'match',
        expectedRevision: '1',
        targetEntityId: entityId,
        strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'FORGED-1' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_INVALID' })
  })

  it('requires a matching reviewed target identity before using a native id across candidates', async () => {
    const { service, candidates, store } = await harness()
    const anchor = deviceCandidate()
    await seed(candidates, anchor)
    const created = await decide(service, anchor, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, anchor, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
    })

    const incoming = deviceCandidate({
      nativeId: 'DEV-2',
      attributes: [
        { attributeId: 'device_native_id', value: 'DEV-2' },
        { attributeId: 'device_name', value: 'Charger Two' },
        { attributeId: 'site', value: 'site-a' },
      ],
    })
    await seed(candidates, incoming)
    await expect(
      decide(service, incoming, { kind: 'match', expectedRevision: '0', targetEntityId: entityId }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })

    await expect(
      decide(service, incoming, {
        kind: 'match',
        expectedRevision: '0',
        targetEntityId: entityId,
        strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-2' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EVIDENCE_REQUIRED' })

    const manualMatch = await decide(service, incoming, {
      kind: 'match',
      expectedRevision: '0',
      targetEntityId: entityId,
      justification: 'The reviewer independently verified this source against the cluster record.',
    })
    expect(manualMatch.kind).toBe('match')

    const verifiedIncoming = deviceCandidate({ nativeId: 'DEV-1' })
    await seed(candidates, verifiedIncoming)
    const matched = await decide(service, verifiedIncoming, {
      kind: 'match',
      expectedRevision: '0',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
    })
    expect(matched.kind).toBe('match')
    expect(await store.latestRevision(SCOPE, verifiedIncoming.candidateId, CTX)).toBe('1')
  })

  it('requires equal definition-scoped identity dimensions even for a manual match', async () => {
    const { service, candidates } = await harness()
    const first = deviceCandidate()
    await seed(candidates, first)
    const created = await decide(service, first, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')

    const otherSite = deviceCandidate({
      attributes: [
        { attributeId: 'device_native_id', value: 'DEV-2' },
        { attributeId: 'device_name', value: 'Charger Two' },
        { attributeId: 'site', value: 'site-b' },
      ],
    })
    await seed(candidates, otherSite)
    await expect(
      decide(service, otherSite, {
        kind: 'match',
        expectedRevision: '0',
        targetEntityId: entityId,
        justification: 'same display name is insufficient',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_SCOPE_MISMATCH' })

    const missingSite = deviceCandidate({
      attributes: [
        { attributeId: 'device_native_id', value: 'DEV-3' },
        { attributeId: 'device_name', value: 'Unscoped One' },
      ],
    })
    await seed(candidates, missingSite)
    const unscopedCreated = await decide(service, missingSite, { kind: 'create_pending' })
    const unscopedEntityId = unscopedCreated.targetEntityId
    if (unscopedEntityId === undefined) throw new Error('expected an unscoped pending entity')
    const anotherUnscoped = deviceCandidate({
      attributes: [
        { attributeId: 'device_native_id', value: 'DEV-4' },
        { attributeId: 'device_name', value: 'Unscoped Two' },
      ],
    })
    await seed(candidates, anotherUnscoped)
    await expect(
      decide(service, anotherUnscoped, {
        kind: 'match',
        expectedRevision: '0',
        targetEntityId: unscopedEntityId,
        justification: 'dimensionless records cannot be safely combined',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_SCOPE_MISMATCH' })
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
        strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT', httpStatus: 409 })
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
        strongIdentity: { kind: 'native_id', attributeId: 'sensor_native_id', value: 'SNS-1' },
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
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
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

  it('increments the scope read revision only for committed writes and pins batch bindings', async () => {
    const { service, candidates, store } = await harness()
    const candidate = deviceCandidate()
    await seed(candidates, candidate)
    expect(await store.latestReadRevision(SCOPE, CTX)).toBe('0')

    const created = await decide(service, candidate, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    expect(await store.latestReadRevision(SCOPE, CTX)).toBe('1')
    expect(await store.getEntity(SCOPE, entityId, CTX)).toMatchObject({
      scopeDimensions: { site: 'site-a' },
      createdFromCandidateId: candidate.candidateId,
      state: 'pending',
      revision: '1',
    })

    const failedWrite: AppendIdentityDecisionInput = {
      expectedRevision: '1',
      expectedTargetEntityRevision: '1',
      draft: {
        decisionId: randomUUID(),
        candidateId: candidate.candidateId,
        objectId: 'device',
        identityScopeId: 'device_identity',
        kind: 'split',
        targetEntityId: entityId,
        evidenceRefs: [],
        recordedAt: '2026-09-22T00:00:01Z',
        actor: 'reviewer',
      },
      closeAssertions: [
        { assertionId: randomUUID(), validTo: '2026-09-22T00:00:01Z' },
      ],
    }
    await expect(store.appendDecision(SCOPE, failedWrite, CTX)).rejects.toMatchObject({ code: 'DECISION_STORE_FAILED' })
    expect(await store.latestReadRevision(SCOPE, CTX)).toBe('1')
    expect((await store.getEntity(SCOPE, entityId, CTX))?.revision).toBe('1')
    expect(await store.latestRevision(SCOPE, candidate.candidateId, CTX)).toBe('1')

    const matched = await decide(service, candidate, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
    })
    expect(matched.revision).toBe('2')
    expect(await store.latestReadRevision(SCOPE, CTX)).toBe('2')
    const binding = await store.readPublishedBindings(SCOPE, [candidate.candidateId], CTX)
    expect(binding).toMatchObject({ readRevision: '2', complete: true })
    expect(binding.bindings[0]?.openAssertions.map((assertion) => assertion.entityId)).toEqual([entityId])
    const overCap = await store.readPublishedBindings(SCOPE, Array.from({ length: 1_001 }, () => randomUUID()), CTX)
    expect(overCap.complete).toBe(false)
    expect(overCap.bindings).toHaveLength(1_000)

    await expect(store.latestReadRevision({ ...SCOPE, tenantId: '22222222-3333-4444-8555-666666666666' }, CTX)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('serializes concurrent cluster mutations against the target entity revision', async () => {
    const { service, candidates, store } = await harness()
    const anchor = deviceCandidate()
    await seed(candidates, anchor)
    const created = await decide(service, anchor, { kind: 'create_pending' })
    const entityId = created.targetEntityId
    if (entityId === undefined) throw new Error('expected a created entity')
    await decide(service, anchor, {
      kind: 'match',
      expectedRevision: '1',
      targetEntityId: entityId,
      strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
    })
    const target = await store.getEntity(SCOPE, entityId, CTX)
    if (target === undefined) throw new Error('expected a confirmed target entity')
    const first = deviceCandidate()
    const second = deviceCandidate()
    await seed(candidates, first)
    await seed(candidates, second)

    const appendMatch = (candidate: EntityCandidate): AppendIdentityDecisionInput => {
      const decisionId = randomUUID()
      return {
        expectedRevision: '0',
        expectedTargetEntityRevision: target.revision,
        draft: {
          decisionId,
          candidateId: candidate.candidateId,
          objectId: 'device',
          identityScopeId: 'device_identity',
          kind: 'match',
          targetEntityId: entityId,
          strongIdentity: { kind: 'native_id', attributeId: 'device_native_id', value: 'DEV-1' },
          evidenceRefs: [],
          recordedAt: '2026-09-22T00:00:02Z',
          actor: 'reviewer',
        },
        openAssertion: {
          assertionId: randomUUID(),
          candidateId: candidate.candidateId,
          entityId,
          objectId: 'device',
          identityScopeId: 'device_identity',
          decisionId,
          validFrom: '2026-09-22T00:00:02Z',
          recordedAt: '2026-09-22T00:00:02Z',
        },
      }
    }
    const results = await Promise.allSettled([
      store.appendDecision(SCOPE, appendMatch(first), CTX),
      store.appendDecision(SCOPE, appendMatch(second), CTX),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await store.latestReadRevision(SCOPE, CTX)).toBe('3')
  })
})
