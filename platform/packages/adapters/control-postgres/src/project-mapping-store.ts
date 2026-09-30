import type { QueryResultRow } from 'pg'
import {
  ProjectMappingStoreError,
  assertImportMappingVersionShape,
  isToolContext,
  isUuid,
  tryParseSemver,
} from '@ontology/contracts'
import type {
  ImportMappingVersion,
  InsertMappingResult,
  MappingRef,
  ProjectMappingStore,
  ProjectMappingWriteMeta,
  ScopeRef,
  Semver,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface MappingRow extends QueryResultRow {
  digest: string
  body: ImportMappingVersion
  request_digest?: string
}

const MAPPING_COLUMNS = 'digest, body, request_digest'

function sourceObjectRefOf(mapping: ImportMappingVersion): MappingRef['sourceObjectRef'] {
  return mapping.ref.sourceObjectRef
}

function definitionRefOf(mapping: ImportMappingVersion): VersionRef {
  return mapping.definitionRef
}

/**
 * Real PostgreSQL implementation of the import-mapping store (SPEC v0.3a §4.1/§6.2).
 *
 * Every statement runs inside one transaction whose trusted scope is set with `SET LOCAL`
 * semantics, so RLS applies as a second layer behind the explicit scope predicate. A mapping
 * version is immutable: the store only inserts, and re-inserting the exact same
 * `(project, mappingId, version)` replays it while a different digest is refused.
 */
export class PostgresProjectMappingStore implements ProjectMappingStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insertMapping(
    scopeRef: ScopeRef,
    mapping: ImportMappingVersion,
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<InsertMappingResult> {
    assertImportMappingVersionShape(mapping)
    if (!isUuid(mapping.projectId)) {
      throw new ProjectMappingStoreError('INVALID_MAPPING', 'projectId must be a uuid')
    }
    if (typeof mapping.version !== 'string' || tryParseSemver(mapping.version) === undefined) {
      throw new ProjectMappingStoreError('INVALID_MAPPING', 'mapping version must be a semver string')
    }

    return this.#withScope(scopeRef, ctx, async (query) => {
      const replay = await this.#byIdempotencyKey(query, meta.idempotencyKey)
      if (replay !== undefined) {
        if (replay.request_digest !== meta.requestDigest) {
          throw new ProjectMappingStoreError(
            'IDEMPOTENCY_CONFLICT',
            'the idempotency key was already used with a different mapping payload',
          )
        }
        return { mapping: replay.body, created: false }
      }

      const inserted = await query
        .query<MappingRow>(
          `INSERT INTO agent_platform.project_mapping_versions
             (tenant_id, space_id, project_id, mapping_id, version, digest, definition_ref,
              source_object_ref, body, idempotency_key, request_digest, actor, trace_id, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10,
             current_setting('app.trace_id', true), $11::timestamptz)
           ON CONFLICT (tenant_id, space_id, project_id, mapping_id, version) DO NOTHING
           RETURNING ${MAPPING_COLUMNS}`,
          [
            mapping.projectId,
            mapping.mappingId,
            mapping.version,
            mapping.digest,
            JSON.stringify(definitionRefOf(mapping)),
            JSON.stringify(sourceObjectRefOf(mapping)),
            JSON.stringify(mapping),
            meta.idempotencyKey,
            meta.requestDigest,
            mapping.actor,
            mapping.recordedAt,
          ],
        )
        .catch((error: unknown) => {
          if (pgCodeOf(error) === '23505') return { rows: [], rowCount: 0 }
          throw error
        })

      const row = inserted.rows[0]
      if (row !== undefined) {
        return { mapping: row.body, created: true }
      }

      const existing = await this.#byKey(query, mapping.projectId, mapping.mappingId, mapping.version)
      if (existing === undefined) {
        throw new ProjectMappingStoreError('INVALID_MAPPING', 'the mapping version could not be written')
      }
      if (existing.digest !== mapping.digest) {
        throw new ProjectMappingStoreError(
          'INVALID_MAPPING',
          `mapping ${mapping.mappingId}@${mapping.version} already exists with a different digest`,
        )
      }
      return { mapping: existing.body, created: false }
    })
  }

  async getMapping(
    scopeRef: ScopeRef,
    projectId: Uuid,
    mappingId: Uuid,
    version: Semver,
    ctx: ToolContext,
  ): Promise<ImportMappingVersion | undefined> {
    if (!isUuid(mappingId)) {
      throw new ProjectMappingStoreError('INVALID_MAPPING', 'mappingId must be a uuid')
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const row = await this.#byKey(query, projectId, mappingId, version)
      return row?.body
    })
  }

  async listMappings(
    scopeRef: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<ImportMappingVersion[]> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<MappingRow>(
        `SELECT ${MAPPING_COLUMNS} FROM agent_platform.project_mapping_versions
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid
           ORDER BY mapping_id, version`,
        [projectId],
      )
      return result.rows.map((row) => row.body)
    })
  }

  async latestVersion(
    scopeRef: ScopeRef,
    projectId: Uuid,
    mappingId: Uuid,
    ctx: ToolContext,
  ): Promise<Semver | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ version: string }>(
        `SELECT version FROM agent_platform.project_mapping_versions
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND project_id = $1::uuid AND mapping_id = $2::uuid
           ORDER BY version DESC
           LIMIT 1`,
        [projectId, mappingId],
      )
      return result.rows[0]?.version
    })
  }

  async #byKey(
    query: ScopedQuery,
    projectId: Uuid,
    mappingId: Uuid,
    version: Semver,
  ): Promise<MappingRow | undefined> {
    const result = await query.query<MappingRow>(
      `SELECT ${MAPPING_COLUMNS} FROM agent_platform.project_mapping_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND project_id = $1::uuid AND mapping_id = $2::uuid AND version = $3`,
      [projectId, mappingId, version],
    )
    return result.rows[0]
  }

  async #byIdempotencyKey(query: ScopedQuery, key: string): Promise<MappingRow | undefined> {
    const result = await query.query<MappingRow>(
      `SELECT ${MAPPING_COLUMNS}, request_digest FROM agent_platform.project_mapping_versions
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND space_id = current_setting('app.space_id')::uuid
           AND idempotency_key = $1`,
      [key],
    )
    return result.rows[0]
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectMappingStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope(
      { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
      async (client) => {
        await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
        return run({
          query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
            return { rows: result.rows, rowCount: result.rowCount ?? 0 }
          },
        })
      },
    )
  }
}

function pgCodeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return error.code
}
