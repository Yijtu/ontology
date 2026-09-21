import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  BlobPutImmutableResponse,
  ComponentManifest,
  ControlAppendEventRequest,
  ControlAppendEventResponse,
  ControlRepository,
  ProjectionState,
  ResourceRef,
  ToolContext,
} from '@ontology/contracts'
import { createToolContext } from '@ontology/contracts'
import type { ManifestValidator } from '@ontology/application'
import { createAjv, validator } from '../contracts/helpers'

export const TENANT_A = '11111111-1111-4111-8111-111111111111'
export const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const TENANT_B = '22222222-2222-4222-8222-222222222222'
export const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const RUN_A = '33333333-3333-4333-8333-333333333333'
export const RUN_B = '44444444-4444-4444-8444-444444444444'
export const RESERVATION_ID = '55555555-5555-4555-8555-555555555555'
export const ARTIFACT_ID = '66666666-6666-4666-8666-666666666666'

export const DIGEST_A = `sha256:${'a'.repeat(64)}`
export const DIGEST_B = `sha256:${'b'.repeat(64)}`

/**
 * The canonical JSON-Schema validator, built from the same schema bundle the platform
 * publishes. The application layer receives it by injection and never imports a
 * schema library itself.
 */
export function canonicalManifestValidator(): ManifestValidator {
  const ajv = createAjv()
  const validate = validator(ajv, 'component.schema.json', 'ComponentManifest')
  return (manifest: unknown) => {
    if (validate(manifest)) return { valid: true, issues: [] }
    return {
      valid: false,
      issues: (validate.errors ?? []).map((error) => ({
        pointer: error.instancePath === '' ? '$' : error.instancePath,
        message: error.message ?? 'invalid',
      })),
    }
  }
}

export function sampleManifest(overrides?: Partial<ComponentManifest>): ComponentManifest {
  const base: ComponentManifest = {
    kind: 'data_backend',
    id: 'telemetry-pg',
    version: '1.0.0',
    digest: DIGEST_A,
    contractRange: { min: '1.0.0', max: '2.0.0' },
    provides: [
      {
        name: 'telemetry.read',
        version: '1.0.0',
        limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 5000 },
        consistency: 'read_time',
        cancellation: 'supported',
        pagination: 'cursor',
        supportedDataTypes: ['decimal', 'timestamp'],
      },
    ],
    requires: [],
    entrypointRef: { kind: 'package', ref: '@ontology/adapter-data-postgres' },
    trustStatus: 'verified',
  }
  return { ...base, ...overrides }
}

export function sampleArtifactRef(digest = DIGEST_A, id = ARTIFACT_ID): ResourceRef {
  return { id, version: '1.0.0', digest, kind: 'artifact' }
}

export function toolContext(
  tenantId = TENANT_A,
  spaceId = SPACE_A,
  roles: readonly string[] = ['platform-admin'],
  subjectId = 'unit-test',
  runId = RUN_A,
): ToolContext {
  return createToolContext({
    principal: { tenantId, subjectId, roles: [...roles], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST_A,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-component-registry-unit',
  })
}

/** Minimal blob port: only the authorized set matters for registration. */
export class FakeBlobPort implements BlobPort {
  readonly #authorized = new Map<string, string>()

  authorize(ref: ResourceRef): void {
    this.#authorized.set(ref.id, ref.digest)
  }

  revoke(ref: ResourceRef): void {
    this.#authorized.delete(ref.id)
  }

  putImmutable(): Promise<BlobPutImmutableResponse> {
    return Promise.reject(new Error('FakeBlobPort.putImmutable is not used by the registry'))
  }

  getAuthorized(request: BlobGetAuthorizedRequest): Promise<BlobGetAuthorizedResponse> {
    const digest = this.#authorized.get(request.blobRef.id)
    if (digest === undefined || digest !== request.blobRef.digest) {
      return Promise.reject(new Error(`artifact ${request.blobRef.id} is not authorized`))
    }
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest: digest,
      mediaType: 'application/octet-stream',
      byteSize: 1,
      integrityVerified: true,
    })
  }
}

/**
 * Records the durable event ledger the registry appends to. It mirrors the real
 * repository's contract: idempotent per (stream, key) and monotonic per stream.
 */
export class RecordingControlRepository implements ControlRepository {
  readonly appended: { streamRef: string; idempotencyKey: string; payloadDigest: string; recordedSeq: string }[] = []
  readonly #byKey = new Map<string, string>()
  #seq = 0

  transaction(): Promise<void> {
    return Promise.reject(new Error('RecordingControlRepository.transaction is not used'))
  }

  readProjection(): Promise<ProjectionState> {
    return Promise.reject(new Error('RecordingControlRepository.readProjection is not used'))
  }

  appendEvent(request: ControlAppendEventRequest): Promise<ControlAppendEventResponse> {
    const key = `${request.streamRef}\u0000${request.idempotencyKey}`
    const existing = this.#byKey.get(key)
    if (existing !== undefined) {
      return Promise.resolve({ recordedSeq: existing, appended: false })
    }
    this.#seq += 1
    const recordedSeq = String(this.#seq)
    this.#byKey.set(key, recordedSeq)
    this.appended.push({
      streamRef: request.streamRef,
      idempotencyKey: request.idempotencyKey,
      payloadDigest: request.payloadDigest,
      recordedSeq,
    })
    return Promise.resolve({ recordedSeq, appended: true })
  }
}

/** Deterministic, strictly increasing clock. */
export function fixedClock(startMs = Date.UTC(2026, 8, 21, 0, 0, 0)): () => string {
  let tick = 0
  return () => {
    const value = new Date(startMs + tick * 1000).toISOString()
    tick += 1
    return value
  }
}
