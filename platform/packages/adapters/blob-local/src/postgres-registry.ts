import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type { ResourceRef, Sha256Digest, Uuid } from '@ontology/contracts'
import { BlobStoreError } from './errors'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  BlobPurpose,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from './registry'
import { resourceKindForPurpose } from './registry'
import type { BlobScope } from './object-store'

export interface PostgresArtifactRegistryConfig {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly statementTimeoutMs?: number
  readonly connectionTimeoutMs?: number
  readonly applicationName?: string
}

const BLOB_REF_VERSION = '1.0.0'

interface BlobRow extends QueryResultRow {
  tenant_id: string
  space_id: string
  content_digest: string
  media_type: string
  byte_size: string
  object_key: string
  lineage_id: string
  created_at: Date
}

interface ReferenceRow extends QueryResultRow {
  tenant_id: string
  space_id: string
  blob_ref_id: string
  content_digest: string
  purpose: string
  run_id: string | null
  tenant_authorized_ref: string | null
  origin: Record<string, unknown> | null
  created_at: Date
}

interface ReferenceJoinRow extends ReferenceRow {
  media_type: string
  byte_size: string
  object_key: string
  lineage_id: string
  blob_created_at: Date
}

function toBlobRecord(row: BlobRow | ReferenceJoinRow): ArtifactBlobRecord {
  return {
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    contentDigest: row.content_digest,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    objectKey: row.object_key,
    lineageId: row.lineage_id,
    createdAt: row.created_at.toISOString(),
  }
}

function toReferenceRecord(row: ReferenceRow): ArtifactReferenceRecord {
  return {
    tenantId: row.tenant_id,
    spaceId: row.space_id,
    blobRefId: row.blob_ref_id,
    contentDigest: row.content_digest,
    purpose: row.purpose as BlobPurpose,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.tenant_authorized_ref === null
      ? {}
      : { tenantAuthorizedRef: row.tenant_authorized_ref }),
    origin: row.origin ?? {},
    createdAt: row.created_at.toISOString(),
  }
}

/**
 * PostgreSQL-backed artifact metadata registry.
 *
 * It connects as the non-owner application role, so RLS is a real second line
 * of defence behind the explicit (tenant_id, space_id) predicates: a statement
 * executed without an established scope matches no row. The session scope is
 * set with `SET LOCAL` semantics and cleared before the connection returns to
 * the pool, so a later request can never inherit the previous tenant.
 */
export class PostgresArtifactRegistry implements ArtifactRegistry {
  readonly #pool: Pool

  constructor(config: PostgresArtifactRegistryConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-blob-local-registry',
      ...(config.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: config.statementTimeoutMs }),
      ...(config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMillis: config.connectionTimeoutMs }),
    })
  }

  async #withScope<T>(
    scope: BlobScope,
    run: (client: PoolClient) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query(options?.readOnly === true ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
        [scope.tenantId, scope.spaceId],
      )
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // keep the original failure; a broken connection is discarded below
      }
      throw error
    } finally {
      let reset = true
      try {
        await client.query(
          "SELECT set_config('app.tenant_id', '', false), set_config('app.space_id', '', false)",
        )
      } catch {
        reset = false
      }
      client.release(!reset)
    }
  }

  async recordReference(
    input: RecordArtifactReferenceInput,
  ): Promise<RecordArtifactReferenceResult> {
    const { scope } = input
    return this.#withScope(scope, async (client) => {
      const candidateLineageId = randomUUID()
      // `DO UPDATE` (rather than `DO NOTHING`) makes two concurrent uploads of
      // the same content converge: the loser waits for the winner's commit and
      // then returns the existing lineage, so neither sees a spurious failure.
      const inserted = await client.query<
        Pick<BlobRow, 'lineage_id' | 'media_type' | 'byte_size'>
      >(
        `INSERT INTO agent_platform.artifact_blobs
           (tenant_id, space_id, content_digest, media_type, byte_size, object_key, lineage_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, space_id, content_digest)
         DO UPDATE SET content_digest = EXCLUDED.content_digest
         RETURNING lineage_id, media_type, byte_size`,
        [
          scope.tenantId,
          scope.spaceId,
          input.contentDigest,
          input.mediaType,
          input.byteSize,
          input.objectKey,
          candidateLineageId,
        ],
      )

      const blobRow = inserted.rows[0]
      if (blobRow === undefined) {
        throw new BlobStoreError(
          'BLOB_REGISTRY_FAILED',
          'the blob row could not be inserted or resolved',
        )
      }
      const lineageId = blobRow.lineage_id
      // The conflict branch keeps the original lineage id, so a different id
      // means this upload reused existing content.
      const deduplicated = lineageId !== candidateLineageId
      if (deduplicated) {
        if (blobRow.media_type !== input.mediaType) {
          throw new BlobStoreError(
            'BLOB_MEDIA_TYPE_CONFLICT',
            `content ${input.contentDigest} is already registered with media type ${blobRow.media_type}`,
          )
        }
        if (Number(blobRow.byte_size) !== input.byteSize) {
          throw new BlobStoreError(
            'BLOB_SIZE_MISMATCH',
            `content ${input.contentDigest} is already registered with size ${blobRow.byte_size}`,
          )
        }
      }

      const referenceInsert = await client.query<{ created_at: Date }>(
        `INSERT INTO agent_platform.artifact_references
           (tenant_id, space_id, blob_ref_id, content_digest, purpose, run_id,
            tenant_authorized_ref, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING created_at`,
        [
          scope.tenantId,
          scope.spaceId,
          input.blobRefId,
          input.contentDigest,
          input.purpose,
          input.runId ?? null,
          input.tenantAuthorizedRef ?? null,
          JSON.stringify(input.origin ?? {}),
        ],
      )
      const createdAt = referenceInsert.rows[0]?.created_at.toISOString() ?? new Date().toISOString()

      const blobRef: ResourceRef = {
        id: input.blobRefId,
        version: BLOB_REF_VERSION,
        digest: input.contentDigest,
        kind: resourceKindForPurpose(input.purpose),
      }
      const reference: ArtifactReferenceRecord = {
        tenantId: scope.tenantId,
        spaceId: scope.spaceId,
        blobRefId: input.blobRefId,
        contentDigest: input.contentDigest,
        purpose: input.purpose,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.tenantAuthorizedRef === undefined
          ? {}
          : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
        origin: input.origin ?? {},
        createdAt,
      }

      return { blobRef, lineageId, deduplicated, reference }
    })
  }

  async findReference(
    scope: BlobScope,
    blobRefId: Uuid,
  ): Promise<ArtifactReferenceView | undefined> {
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<ReferenceJoinRow>(
          `SELECT r.tenant_id, r.space_id, r.blob_ref_id, r.content_digest, r.purpose,
                  r.run_id, r.tenant_authorized_ref, r.origin, r.created_at,
                  b.media_type, b.byte_size, b.object_key, b.lineage_id,
                  b.created_at AS blob_created_at
             FROM agent_platform.artifact_references r
             JOIN agent_platform.artifact_blobs b
               ON b.tenant_id = r.tenant_id
              AND b.space_id = r.space_id
              AND b.content_digest = r.content_digest
            WHERE r.tenant_id = $1 AND r.space_id = $2 AND r.blob_ref_id = $3`,
          [scope.tenantId, scope.spaceId, blobRefId],
        )
        const row = result.rows[0]
        if (row === undefined) {
          return undefined
        }
        return { reference: toReferenceRecord(row), blob: toBlobRecord(row) }
      },
      { readOnly: true },
    )
  }

  async listOrigins(
    scope: BlobScope,
    contentDigest: Sha256Digest,
  ): Promise<readonly ArtifactReferenceRecord[]> {
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<ReferenceRow>(
          `SELECT tenant_id, space_id, blob_ref_id, content_digest, purpose, run_id,
                  tenant_authorized_ref, origin, created_at
             FROM agent_platform.artifact_references
            WHERE tenant_id = $1 AND space_id = $2 AND content_digest = $3
            ORDER BY created_at, blob_ref_id`,
          [scope.tenantId, scope.spaceId, contentDigest],
        )
        return result.rows.map(toReferenceRecord)
      },
      { readOnly: true },
    )
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
