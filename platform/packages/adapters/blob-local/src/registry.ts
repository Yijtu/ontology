import type { ResourceKind, ResourceRef, Sha256Digest, Uuid } from '@ontology/contracts'
import type { BlobScope } from './object-store'

/**
 * Why an immutable object is stored. The purpose is part of the authorization
 * record: a `checkpoint` is additionally bound to the run that produced it, so
 * it is never readable outside that run even inside the same tenant/space.
 */
export type BlobPurpose = 'document' | 'large_result' | 'checkpoint' | 'artifact'

export const BLOB_PURPOSES: readonly BlobPurpose[] = [
  'document',
  'large_result',
  'checkpoint',
  'artifact',
]

export function isBlobPurpose(value: string): value is BlobPurpose {
  return (BLOB_PURPOSES as readonly string[]).includes(value)
}

export function resourceKindForPurpose(purpose: BlobPurpose): ResourceKind {
  switch (purpose) {
    case 'document':
      return 'document'
    case 'checkpoint':
      return 'checkpoint'
    case 'large_result':
    case 'artifact':
      return 'artifact'
  }
}

export interface ArtifactBlobRecord {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
  readonly contentDigest: Sha256Digest
  readonly mediaType: string
  readonly byteSize: number
  readonly objectKey: string
  readonly lineageId: Uuid
  readonly createdAt: string
}

export interface ArtifactReferenceRecord {
  readonly tenantId: Uuid
  readonly spaceId: Uuid
  readonly blobRefId: Uuid
  readonly contentDigest: Sha256Digest
  readonly purpose: BlobPurpose
  readonly runId?: Uuid
  readonly tenantAuthorizedRef?: string
  readonly origin: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface RecordArtifactReferenceInput {
  readonly scope: BlobScope
  readonly blobRefId: Uuid
  readonly contentDigest: Sha256Digest
  readonly mediaType: string
  readonly byteSize: number
  readonly objectKey: string
  readonly purpose: BlobPurpose
  readonly runId?: Uuid
  readonly tenantAuthorizedRef?: string
  readonly origin?: Readonly<Record<string, unknown>>
}

export interface RecordArtifactReferenceResult {
  readonly blobRef: ResourceRef
  readonly lineageId: Uuid
  readonly deduplicated: boolean
  readonly reference: ArtifactReferenceRecord
}

export interface ArtifactReferenceView {
  readonly reference: ArtifactReferenceRecord
  readonly blob: ArtifactBlobRecord
}

/**
 * Tenant/space-scoped metadata registry behind `LocalImmutableBlobStore`. Every
 * method is scoped: a lookup in the wrong scope returns nothing, never a row.
 */
export interface ArtifactRegistry {
  recordReference(input: RecordArtifactReferenceInput): Promise<RecordArtifactReferenceResult>
  findReference(scope: BlobScope, blobRefId: Uuid): Promise<ArtifactReferenceView | undefined>
  listOrigins(
    scope: BlobScope,
    contentDigest: Sha256Digest,
  ): Promise<readonly ArtifactReferenceRecord[]>
  close(): Promise<void>
}
