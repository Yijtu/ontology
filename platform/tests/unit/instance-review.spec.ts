import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  InstanceFieldSource,
  InstanceIdentityCandidate,
  InstanceNormalizedValue,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { InstanceReviewError } from '@ontology/contracts'
import {
  InMemoryInstanceReviewStore,
  InstanceReviewService,
} from '@ontology/application'
import type { InstanceFieldPolicy } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'

const ctx: ToolContext = toolContext()

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function source(fieldId: string): InstanceFieldSource {
  return {
    documentRef: resourceRef(),
    parseId: randomUUID(),
    chunkId: randomUUID(),
    locator: { kind: 'json_pointer', pointer: `/${fieldId}`, startByte: 0, endByte: 4, normalizationMapRef: 'nm-1' },
    textDigest: DIGEST,
    quoteDigest: DIGEST,
  }
}

function field(
  fieldId: string,
  rawValue: string,
  normalizedValue?: InstanceNormalizedValue,
): { fieldId: string; rawValue: string; normalizedValue?: InstanceNormalizedValue; source: InstanceFieldSource } {
  return {
    fieldId,
    rawValue,
    ...(normalizedValue === undefined ? {} : { normalizedValue }),
    source: source(fieldId),
  }
}

function candidate(entityId: string, objectId: string, displayName: string, strategy: InstanceIdentityCandidate['strategy'] = 'similarity'): InstanceIdentityCandidate {
  return { entityId, objectId, displayName, strategy }
}

const KNOWN_FIELDS = new Map<string, 'scalar' | 'quantity'>([
  ['device_name', 'scalar'],
  ['capacity', 'quantity'],
])

/** Reject an unknown field or a quantity with no unit, matching "unknown enters pending". */
const fieldPolicy: InstanceFieldPolicy = {
  validate: ({ objectTypeRef, fieldId, normalizedValue }) => {
    if (objectTypeRef !== 'device') return undefined
    const kind = KNOWN_FIELDS.get(fieldId)
    if (kind === undefined) return 'unknown field'
    if (normalizedValue === undefined) return 'no normalized value yet'
    if (kind === 'quantity' && normalizedValue.kind !== 'quantity') return 'expected a quantity'
    return undefined
  },
}

function serviceWithStore(): { service: InstanceReviewService; store: InMemoryInstanceReviewStore } {
  const store = new InMemoryInstanceReviewStore()
  const service = new InstanceReviewService({ store, fieldPolicy, now: () => '2026-09-29T00:00:00Z' })
  return { service, store }
}

async function createRecord(
  service: InstanceReviewService,
  overrides: {
    readonly objectTypeRef?: string
    readonly displayName?: string
    readonly fields?: ReturnType<typeof field>[]
    readonly relations?: { relationId: string; relationTypeRef: string; toRecordId?: Uuid }[]
    readonly identityCandidates?: InstanceIdentityCandidate[]
  } = {},
) {
  return service.createRecord(
    ctx.allowedResources,
    PROJECT_ID,
    {
      objectTypeRef: overrides.objectTypeRef ?? 'device',
      ...(overrides.displayName === undefined ? {} : { displayName: overrides.displayName }),
      identityCandidates: overrides.identityCandidates ?? [],
      fields: overrides.fields ?? [field('device_name', 'Bridge A', { kind: 'scalar', value: 'Bridge A' })],
      relations: overrides.relations ?? [],
      sourceRef: resourceRef(),
      actor: ctx.principal.subjectId,
      idempotencyKey: `idem-${randomUUID()}`,
    },
    ctx,
  )
}

describe('instance review service (key-field confirmation and identity)', () => {
  it('creates a record with raw/normalized/source/status and computes identity confidence', async () => {
    const { service } = serviceWithStore()
    const entity = randomUUID()
    const record = await createRecord(service, {
      displayName: 'Bridge A',
      identityCandidates: [
        candidate(entity, 'device', 'Bridge A', 'native_id'),
        candidate(randomUUID(), 'sensor', 'Bridge A', 'context'),
      ],
    })
    expect(record.recordRevision).toBe('1')
    expect(record.publicationState).toBe('draft')
    expect(record.fields[0]).toMatchObject({ fieldId: 'device_name', status: 'pending' })
    expect(record.fields[0]?.source.locator.kind).toBe('json_pointer')
    expect(record.identity.confidence).toBe('exact')
    // A candidate that shares the display name but is a different object is flagged.
    expect(record.identity.sameNameDifferentMeaning).toBe(true)
  })

  it('keeps an unknown field and an unresolved relation endpoint pending and blocks publication', async () => {
    const { service } = serviceWithStore()
    const record = await createRecord(service, {
      fields: [field('mystery_field', 'x', { kind: 'scalar', value: 'x' })],
      relations: [{ relationId: 'r1', relationTypeRef: 'device.part_of' }],
    })
    expect(record.fields[0]?.status).toBe('pending')
    expect(record.fields[0]?.reason).toBe('unknown field')
    expect(record.relations[0]?.endpointState).toBe('pending')
    await expect(
      service.approve(ctx.allowedResources, PROJECT_ID, record.recordId, {
        expectedRevision: record.recordRevision,
        idempotencyKey: `idem-${randomUUID()}`,
      }, ctx),
    ).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' })
  })

  it('confirms an eligible field, records actor/time/revision and skips an unknown field', async () => {
    const { service, store } = serviceWithStore()
    const record = await createRecord(service)
    const outcome = await service.confirmFields(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      {
        expectedRevision: '1',
        decisions: [
          { fieldId: 'device_name', decision: 'confirm' },
          { fieldId: 'missing_field', decision: 'confirm' },
        ],
        idempotencyKey: `idem-${randomUUID()}`,
      },
      ctx,
    )
    expect(outcome.accepted).toEqual([{ fieldId: 'device_name', status: 'confirmed' }])
    expect(outcome.skipped.map((entry) => entry.fieldId)).toContain('missing_field')
    const confirmed = outcome.record.fields[0]
    expect(confirmed?.status).toBe('confirmed')
    expect(confirmed?.actor).toBe(ctx.principal.subjectId)
    expect(confirmed?.confirmedAt).toBe('2026-09-29T00:00:00Z')
    expect(BigInt(confirmed?.confirmationRevision ?? '0')).toBeGreaterThan(0n)
    // The unknown field still enters a pending confirmation event rather than a silent success.
    const events = await store.listConfirmations(ctx.allowedResources, PROJECT_ID, record.recordId, ctx)
    expect(events.some((event) => event.fieldId === 'missing_field' && event.status === 'pending')).toBe(true)
  })

  it('re-enters pending after a field edit and requires a fresh confirmation', async () => {
    const { service } = serviceWithStore()
    const record = await createRecord(service)
    const confirmed = await service.confirmFields(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '1', decisions: [{ fieldId: 'device_name', decision: 'confirm' }], idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(confirmed.record.recordRevision).toBe('2')
    const edited = await service.editField(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      {
        expectedRevision: '2',
        fieldId: 'device_name',
        normalizedValue: { kind: 'scalar', value: 'Bridge B' },
        reason: '来源显示新值',
        idempotencyKey: `idem-${randomUUID()}`,
      },
      ctx,
    )
    expect(edited.recordRevision).toBe('3')
    expect(edited.fields[0]).toMatchObject({ status: 'pending' })
    // The stale confirmation is preserved in the append-only history.
    await expect(
      service.approve(ctx.allowedResources, PROJECT_ID, record.recordId, {
        expectedRevision: '3',
        idempotencyKey: `idem-${randomUUID()}`,
      }, ctx),
    ).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' })
  })

  it('rejects a stale revision with VERSION_CONFLICT', async () => {
    const { service } = serviceWithStore()
    const record = await createRecord(service)
    await expect(
      service.editField(
        ctx.allowedResources,
        PROJECT_ID,
        record.recordId,
        {
          expectedRevision: '9',
          fieldId: 'device_name',
          normalizedValue: { kind: 'scalar', value: 'x' },
          reason: 'stale',
          idempotencyKey: `idem-${randomUUID()}`,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('adjudicates identity with match / cannot-link / split and refuses a cross-object match', async () => {
    const { service } = serviceWithStore()
    const device = randomUUID()
    const sensor = randomUUID()
    const record = await createRecord(service, {
      identityCandidates: [candidate(device, 'device', 'Bridge A', 'native_id'), candidate(sensor, 'sensor', 'Bridge A', 'context')],
    })
    const matched = await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '1', kind: 'match', targetEntityId: device, reason: 'native id exact', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(matched.identity.state).toBe('matched')
    expect(matched.identity.matchedEntityId).toBe(device)
    expect(matched.identity.adjudications).toHaveLength(1)

    // A sensor candidate can never be merged into a device record.
    await expect(
      service.adjudicateIdentity(
        ctx.allowedResources,
        PROJECT_ID,
        record.recordId,
        { expectedRevision: '2', kind: 'match', targetEntityId: sensor, reason: 'same name', idempotencyKey: `idem-${randomUUID()}` },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })

    const split = await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '2', kind: 'split', targetEntityId: device, reason: 'wrong merge', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(split.identity.state).toBe('split')
    expect(split.identity.matchedEntityId).toBeUndefined()

    const cannot = await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '3', kind: 'cannot_link', targetEntityId: sensor, reason: 'different entity', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(cannot.identity.cannotLinkEntityIds).toContain(sensor)
  })

  it('separates approve from publish and reads the published revision back', async () => {
    const { service } = serviceWithStore()
    const record = await createRecord(service)
    await service.confirmFields(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '1', decisions: [{ fieldId: 'device_name', decision: 'confirm' }], idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '2', kind: 'create', reason: 'new entity', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    const approved = await service.approve(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '3', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(approved.publicationState).toBe('approved')
    expect(approved.publishedRevision).toBeUndefined()

    // Publishing is a distinct transition; before approval it is refused.
    const published = await service.publish(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '4', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(published.publicationState).toBe('published')
    expect(published.publishedRevision).toBe('5')

    // An ordinary read reads the published revision back.
    const readBack = await service.getRecord(ctx.allowedResources, PROJECT_ID, record.recordId, ctx)
    expect(readBack.publicationState).toBe('published')
    expect(readBack.publishedRevision).toBe('5')
  })

  it('never deletes an independent record when two records merge onto one entity', async () => {
    const { service } = serviceWithStore()
    const entity = randomUUID()
    const first = await createRecord(service, { displayName: 'Bridge A', identityCandidates: [candidate(entity, 'device', 'Bridge A', 'native_id')] })
    const second = await createRecord(service, { displayName: 'Bridge A', identityCandidates: [candidate(entity, 'device', 'Bridge A', 'native_id')] })
    const merged = await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      second.recordId,
      { expectedRevision: '1', kind: 'match', targetEntityId: entity, reason: 'same device', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    expect(merged.identity.state).toBe('matched')
    const records = await service.listRecords(ctx.allowedResources, PROJECT_ID, {}, ctx)
    // Both stable record ids survive; merging is not deletion.
    expect(records.map((entry) => entry.recordId).sort()).toEqual([first.recordId, second.recordId].sort())
    expect(records).toHaveLength(2)
  })

  it('records cannot-link against an entity matched on the same record only through a split', async () => {
    const { service } = serviceWithStore()
    const entity = randomUUID()
    const record = await createRecord(service, { identityCandidates: [candidate(entity, 'device', 'Bridge A', 'native_id')] })
    await service.adjudicateIdentity(
      ctx.allowedResources,
      PROJECT_ID,
      record.recordId,
      { expectedRevision: '1', kind: 'match', targetEntityId: entity, reason: 'match', idempotencyKey: `idem-${randomUUID()}` },
      ctx,
    )
    await expect(
      service.adjudicateIdentity(
        ctx.allowedResources,
        PROJECT_ID,
        record.recordId,
        { expectedRevision: '2', kind: 'cannot_link', targetEntityId: entity, reason: 'block', idempotencyKey: `idem-${randomUUID()}` },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
  })

  it('rejects a cross-scope read/write', async () => {
    const { service } = serviceWithStore()
    const record = await createRecord(service)
    const otherScope = { tenantId: randomUUID(), spaceId: randomUUID() }
    await expect(service.getRecord(otherScope, PROJECT_ID, record.recordId, ctx)).rejects.toBeInstanceOf(
      InstanceReviewError,
    )
  })
})
