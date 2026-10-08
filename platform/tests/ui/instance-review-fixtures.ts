import { randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { InMemoryInstanceReviewStore, InstanceReviewService } from '@ontology/application'
import type { InstanceFieldPolicy } from '@ontology/application'
import type { CreateInstanceRecordInput } from '@ontology/application'
import { createToolContext, InstanceReviewError } from '@ontology/contracts'
import type {
  InstanceFieldSource,
  InstanceIdentityBinding,
  InstanceRecordView,
  InstanceNormalizedValue,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'

/**
 * Test-only in-memory harness for the public instance review surface (V03-013 / #182). It
 * mounts the real Fastify routes over the shared in-memory store so the browser E2E drives
 * actual HTTP behaviour (confirm, edit, identity adjudication, approve/publish and read-back)
 * rather than a hand-written fake.
 */

export const INSTANCE_REVIEW_SCOPE: ScopeRef = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

export const INSTANCE_REVIEW_PROJECT_ID = '44444444-4444-4444-8444-444444444444'

const DIGEST = `sha256:${'a'.repeat(64)}`

export function instanceResourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function source(fieldId: string): InstanceFieldSource {
  return {
    documentRef: instanceResourceRef(),
    parseId: randomUUID(),
    chunkId: randomUUID(),
    locator: { kind: 'json_pointer', pointer: `/${fieldId}`, startByte: 0, endByte: 4, normalizationMapRef: 'nm-1' },
    textDigest: DIGEST,
    quoteDigest: DIGEST,
  }
}

const fieldPolicy: InstanceFieldPolicy = {
  validate: ({ objectTypeRef, fieldId, normalizedValue }) => {
    if (objectTypeRef !== 'device') return undefined
    if (fieldId !== 'device_name' && fieldId !== 'capacity') return 'unknown field'
    if (normalizedValue === undefined) return 'no normalized value yet'
    return undefined
  },
}

function trustedContext(subjectId: string): ToolContext {
  return createToolContext({
    principal: { tenantId: INSTANCE_REVIEW_SCOPE.tenantId, subjectId, roles: ['semantic-reviewer', 'data-editor'], scopes: [], authEpoch: 1 },
    runId: '55555555-5555-4555-8555-555555555555',
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: '66666666-6666-4666-8666-666666666666',
      runId: '55555555-5555-4555-8555-555555555555',
      grantedAt: '2026-09-29T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: INSTANCE_REVIEW_SCOPE.tenantId,
      spaceId: INSTANCE_REVIEW_SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-instance-review-fixture',
  })
}

/** Fixed-principal authenticator for the browser E2E harness (loopback only). */
export function instanceReviewAuthenticator(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: INSTANCE_REVIEW_SCOPE.tenantId,
      subjectId: 'e2e-reviewer',
      roles: ['semantic-reviewer', 'data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: INSTANCE_REVIEW_SCOPE.spaceId,
  }
}

export interface InstanceReviewHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly service: InstanceReviewService
  readonly ctx: ToolContext
  readonly recordIds: { readonly main: Uuid; readonly duplicate: Uuid; readonly pendingRelation: Uuid }
  readonly close: () => Promise<void>
}

export async function startInstanceReviewHarness(): Promise<InstanceReviewHarness> {
  const store = new InMemoryInstanceReviewStore()
  const service = new InstanceReviewService({
    store,
    fieldPolicy,
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
  })
  const ctx = trustedContext('e2e-reviewer')
  const scope = INSTANCE_REVIEW_SCOPE
  const projectId = INSTANCE_REVIEW_PROJECT_ID
  const trusted = new Map<string, { readonly binding: InstanceIdentityBinding; readonly sourceRef: ResourceRef; readonly objectTypeRef: string }>()
  const createTrustedRecord = async (input: CreateInstanceRecordInput) => {
    const binding: InstanceIdentityBinding = {
      candidateId: randomUUID(), documentId: input.sourceRef.id,
      projectRevisionRef: { projectId, revision: '1', digest: DIGEST },
      definitionRef: { id: 'ui-fixture.definition', version: '1.0.0', digest: DIGEST },
      membershipRevision: '1', visibilityEpoch: '1', identityScopeId: `${input.objectTypeRef}_identity`,
    }
    trusted.set(binding.candidateId, { binding, sourceRef: input.sourceRef, objectTypeRef: input.objectTypeRef })
    return service.createRecord(scope, projectId, { ...input, identityBinding: binding }, ctx)
  }
  const requireTrustedRecord = async (requestedScope: ScopeRef, project: string, recordId: string, context: ToolContext): Promise<InstanceRecordView> => {
    const record = await service.getRecord(requestedScope, project, recordId, context)
    const fixture = record.identity.binding === undefined ? undefined : trusted.get(record.identity.binding.candidateId)
    if (project !== projectId || fixture === undefined || JSON.stringify(record.identity.binding) !== JSON.stringify(fixture.binding) || JSON.stringify(record.sourceRef) !== JSON.stringify(fixture.sourceRef) || record.objectTypeRef !== fixture.objectTypeRef) throw new InstanceReviewError('IDENTITY_CONFLICT', 'UI record no longer matches its server-seeded candidate/project/source pins')
    return record
  }
  const app = createApiServer({
    authenticate: instanceReviewAuthenticator,
    instanceReviews: {
      service,
      // This browser fixture isolates field/identity rendering over synthetic record projections.
      // Stored-candidate recall and semantic binding authority use the real PostgreSQL acceptance
      // suite; this adapter is confined to the test harness and cannot create records over HTTP.
      identity: {
        recall: async () => { throw new Error('UI fixture does not implement candidate recall') },
        createRecord: async () => { throw new Error('UI fixture seeds trusted records directly') },
        adjudicateIdentity: async (requestedScope, project, recordId, input, context) => {
          await requireTrustedRecord(requestedScope, project, recordId, context)
          return service.adjudicateIdentity(requestedScope, project, recordId, input, context)
        },
        validatePublication: async (scope, project, recordId, context) => {
          const record = await requireTrustedRecord(scope, project, recordId, context)
          if (record.identity.state !== 'matched' && record.identity.state !== 'created') throw new InstanceReviewError('PUBLICATION_BLOCKED', 'a human identity decision is required')
        },
      },
    },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the instance review API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const client = new WorkbenchClient({ baseUrl })

  const mainDeviceEntity = randomUUID()
  const sensorEntity = randomUUID()

  const duplicate = await createTrustedRecord(
    {
      objectTypeRef: 'device',
      displayName: 'Bridge A',
      identityCandidates: [
        { entityId: mainDeviceEntity, objectId: 'device', displayName: 'Bridge A', strategy: 'native_id' },
      ],
      fields: [
        { fieldId: 'device_name', rawValue: 'Bridge A', normalizedValue: { kind: 'scalar', value: 'Bridge A' } as InstanceNormalizedValue, source: source('device_name') },
      ],
      relations: [],
      sourceRef: instanceResourceRef(),
      actor: 'e2e-reviewer',
      idempotencyKey: `seed-duplicate-${randomUUID()}`,
    },
  )

  const main = await createTrustedRecord(
    {
      objectTypeRef: 'device',
      displayName: 'Bridge A',
      identityCandidates: [
        { entityId: mainDeviceEntity, objectId: 'device', displayName: 'Bridge A', strategy: 'native_id' },
        { entityId: sensorEntity, objectId: 'sensor', displayName: 'Bridge A', strategy: 'context' },
      ],
      fields: [
        { fieldId: 'device_name', rawValue: 'Bridge A', normalizedValue: { kind: 'scalar', value: 'Bridge A' } as InstanceNormalizedValue, source: source('device_name') },
        { fieldId: 'capacity', rawValue: '10.5', normalizedValue: { kind: 'quantity', value: '10.5', unitCode: 'kW' } as InstanceNormalizedValue, source: source('capacity') },
      ],
      relations: [{ relationId: 'r-main', relationTypeRef: 'device.part_of', toRecordId: duplicate.recordId }],
      sourceRef: instanceResourceRef(),
      actor: 'e2e-reviewer',
      idempotencyKey: `seed-main-${randomUUID()}`,
    },
  )

  const pendingRelation = await createTrustedRecord(
    {
      objectTypeRef: 'device',
      displayName: 'Bridge B',
      identityCandidates: [],
      fields: [
        { fieldId: 'device_name', rawValue: 'Bridge B', normalizedValue: { kind: 'scalar', value: 'Bridge B' } as InstanceNormalizedValue, source: source('device_name') },
      ],
      relations: [{ relationId: 'r-pending', relationTypeRef: 'device.part_of' }],
      sourceRef: instanceResourceRef(),
      actor: 'e2e-reviewer',
      idempotencyKey: `seed-pending-${randomUUID()}`,
    },
  )

  return {
    app,
    client,
    baseUrl,
    service,
    ctx,
    recordIds: { main: main.recordId, duplicate: duplicate.recordId, pendingRelation: pendingRelation.recordId },
    close: async () => {
      await app.close()
    },
  }
}
