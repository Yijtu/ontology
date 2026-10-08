import type { QueryResultRow } from 'pg'
import {
  assertComputeInvocationRecordShape,
  assertComputeOutputBindingsShape,
  assertComputeResultArtifactShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  ArchivedComputeOutputBindings,
  ArchivedComputeResultArtifact,
  ComputeInvocationAttempt,
  ComputeInvocationClaimResult,
  ComputeInvocationRecord,
  ComputeInvocationStore,
  ComputeOutputBindings,
  ComputeOutputBindingsStore,
  ComputeResultArtifact,
  ComputeResultArtifactStore,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import { ControlStorageError } from './errors'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

async function withScope<T>(
  database: ControlPostgresDatabase,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  run: (query: ScopedQuery) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!isToolContext(ctx)) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return database.withIdentityScope(
    { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
    async (client) => {
      await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
      signal?.throwIfAborted()
      const value = await run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          signal?.throwIfAborted()
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          signal?.throwIfAborted()
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      })
      signal?.throwIfAborted()
      return value
    },
  )
}

interface InvocationRow extends QueryResultRow {
  record: ComputeInvocationRecord
  state: string
  attempt: number
  owner_id: string | null
  lease_expires_at: string | Date | null
}

function leaseMsRemaining(value: string | Date | null, nowIso: string): number {
  if (value === null) return 0
  const expires = value instanceof Date ? value.getTime() : Date.parse(value)
  return expires - Date.parse(nowIso)
}

/**
 * Real PostgreSQL idempotency ledger for registered compute invocations (SPEC v0.3a §EX-6).
 *
 * The logical key digest is the primary key, so a retry of the same logical action reads the
 * one stored record back. `claim` takes a row lock and moves a prepared/failed/cancelled (or
 * lease-expired) record to `executing` under a single owner; a live competing owner leaves the
 * record untouched, which is how a duplicate submission never starts a second handler run.
 */
export class PostgresComputeInvocationStore implements ComputeInvocationStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async createIfAbsent(
    scopeRef: ScopeRef,
    record: ComputeInvocationRecord,
    ctx: ToolContext,
  ): Promise<ComputeInvocationClaimResult> {
    assertComputeInvocationRecordShape(record)
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const now = new Date().toISOString()
      const inserted = await query.query<{ record: ComputeInvocationRecord }>(
        `INSERT INTO agent_platform.compute_invocations
           (tenant_id, space_id, logical_key_digest, invocation_id, state, attempt,
            result_ref, result_digest, owner_id, lease_expires_at, record, recorded_at, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6, NULL, NULL, $7::jsonb, $8::timestamptz, $8::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, logical_key_digest) DO NOTHING
         RETURNING record`,
        [
          record.logicalKeyDigest,
          record.invocationId,
          record.state,
          record.attempt,
          record.resultRef === undefined ? null : JSON.stringify(record.resultRef),
          record.resultDigest ?? null,
          JSON.stringify(record),
          now,
        ],
      )
      if (inserted.rows[0] !== undefined) {
        return { record: inserted.rows[0].record, created: true }
      }
      const existing = await query.query<InvocationRow>(
        `SELECT record, state, attempt, owner_id, lease_expires_at
           FROM agent_platform.compute_invocations
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND logical_key_digest = $1`,
        [record.logicalKeyDigest],
      )
      const row = existing.rows[0]
      if (row === undefined) {
        throw new ControlStorageError('READ_FAILED', 'the compute invocation could not be read back')
      }
      assertComputeInvocationRecordShape(row.record)
      return { record: row.record, created: false }
    })
  }

  async get(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<{ record: ComputeInvocationRecord }>(
        `SELECT record FROM agent_platform.compute_invocations
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND logical_key_digest = $1`,
        [logicalKeyDigest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertComputeInvocationRecordShape(row.record)
      return row.record
    })
  }

  async claim(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    ownerId: string,
    leaseExpiresAt: string,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const now = new Date().toISOString()
      const locked = await query.query<InvocationRow>(
        `SELECT record, state, attempt, owner_id, lease_expires_at
           FROM agent_platform.compute_invocations
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND logical_key_digest = $1
           FOR UPDATE`,
        [logicalKeyDigest],
      )
      const row = locked.rows[0]
      if (row === undefined) return undefined
      assertComputeInvocationRecordShape(row.record)
      const current = row.record
      const liveOwner =
        current.state === 'executing' &&
        row.owner_id !== null &&
        row.owner_id !== ownerId &&
        leaseMsRemaining(row.lease_expires_at, now) > 0
      if (liveOwner) return undefined
      if (current.state === 'completed') return current
      const nextAttempt =
        current.state === 'failed' || current.state === 'cancelled' ? current.attempt + 1 : current.attempt
      const updated: ComputeInvocationRecord = {
        ...current,
        state: 'executing',
        attempt: nextAttempt,
        updatedAt: now,
      }
      await query.query(
        `UPDATE agent_platform.compute_invocations
            SET record = $2::jsonb, state = 'executing', attempt = $3,
                owner_id = $4, lease_expires_at = $5::timestamptz, updated_at = $6::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND logical_key_digest = $1`,
        [logicalKeyDigest, JSON.stringify(updated), nextAttempt, ownerId, leaseExpiresAt, now],
      )
      return updated
    })
  }

  async complete(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    result: { readonly resultRef: ResourceRef; readonly resultDigest: Sha256Digest },
    ctx: ToolContext,
    signal?: AbortSignal,
  ): Promise<ComputeInvocationRecord> {
    return this.#transition(scopeRef, logicalKeyDigest, ctx, (current, now) => ({
      ...current,
      state: 'completed',
      resultRef: result.resultRef,
      resultDigest: result.resultDigest,
      updatedAt: now,
    }), {
      state: 'completed',
      resultRef: result.resultRef,
      resultDigest: result.resultDigest,
    }, signal)
  }

  async fail(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    attempt: ComputeInvocationAttempt,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord> {
    return this.#transition(scopeRef, logicalKeyDigest, ctx, (current, now) => ({
      ...current,
      state: attempt.state,
      attempts: [...current.attempts, attempt],
      updatedAt: now,
    }), { state: attempt.state })
  }

  async #transition(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    ctx: ToolContext,
    mutate: (current: ComputeInvocationRecord, now: string) => ComputeInvocationRecord,
    columns: {
      readonly state: string
      readonly resultRef?: ResourceRef
      readonly resultDigest?: Sha256Digest
    },
    signal?: AbortSignal,
  ): Promise<ComputeInvocationRecord> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const now = new Date().toISOString()
      const locked = await query.query<{ record: ComputeInvocationRecord }>(
        `SELECT record FROM agent_platform.compute_invocations
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND logical_key_digest = $1
           FOR UPDATE`,
        [logicalKeyDigest],
      )
      const row = locked.rows[0]
      if (row === undefined) {
        throw new ControlStorageError('NOT_FOUND', 'the compute invocation no longer exists in this scope')
      }
      assertComputeInvocationRecordShape(row.record)
      if (row.record.state === 'completed') {
        if (columns.state === 'completed' && (
          row.record.resultRef?.id !== columns.resultRef?.id ||
          row.record.resultRef?.version !== columns.resultRef?.version ||
          row.record.resultRef?.digest !== columns.resultRef?.digest ||
          row.record.resultRef?.kind !== columns.resultRef?.kind ||
          row.record.resultDigest !== columns.resultDigest)) {
          throw new ControlStorageError('IDEMPOTENCY_CONFLICT', 'a completed compute invocation cannot adopt another result')
        }
        return row.record
      }
      if (row.record.state !== 'executing') {
        if (columns.state !== 'completed' && (row.record.state === 'failed' || row.record.state === 'cancelled')) return row.record
        throw new ControlStorageError('INVALID_OPERATION', 'only an executing compute invocation can enter a terminal state')
      }
      const updated = mutate(row.record, now)
      assertComputeInvocationRecordShape(updated)
      await query.query(
        `UPDATE agent_platform.compute_invocations
            SET record = $2::jsonb, state = $3, result_ref = $4::jsonb, result_digest = $5,
                owner_id = NULL, lease_expires_at = NULL, updated_at = $6::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND logical_key_digest = $1`,
        [
          logicalKeyDigest,
          JSON.stringify(updated),
          columns.state,
          columns.resultRef === undefined ? null : JSON.stringify(columns.resultRef),
          columns.resultDigest ?? null,
          now,
        ],
      )
      return updated
    }, signal)
  }
}

interface BindingsRow extends QueryResultRow {
  bindings: ComputeOutputBindings
}

/** Real PostgreSQL implementation of the immutable raw output-bindings store. */
export class PostgresComputeOutputBindingsStore implements ComputeOutputBindingsStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putBindings(
    scopeRef: ScopeRef,
    bindingsRef: ResourceRef,
    bindings: ComputeOutputBindings,
    ctx: ToolContext,
  ): Promise<void> {
    assertComputeOutputBindingsShape(bindings)
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.compute_output_bindings
           (tenant_id, space_id, bindings_id, version, digest, output_digest, bindings, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5::jsonb, $6::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, bindings_id, version, digest) DO NOTHING
         RETURNING bindings`,
        [
          bindingsRef.id,
          bindingsRef.version,
          bindingsRef.digest,
          bindings.outputDigest,
          JSON.stringify(bindings),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows.length > 0) return
      const existing = await query.query<BindingsRow & { same_content: boolean }>(
        `SELECT bindings, (bindings = $4::jsonb) AS same_content
           FROM agent_platform.compute_output_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND bindings_id = $1 AND version = $2 AND digest = $3`,
        [bindingsRef.id, bindingsRef.version, bindingsRef.digest, JSON.stringify(bindings)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `compute output bindings ${bindingsRef.id} already exist with different content`,
        )
      }
    })
  }

  async getBindings(
    scopeRef: ScopeRef,
    bindingsRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedComputeOutputBindings | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<BindingsRow>(
        `SELECT bindings FROM agent_platform.compute_output_bindings
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND bindings_id = $1 AND version = $2 AND digest = $3`,
        [bindingsRef.id, bindingsRef.version, bindingsRef.digest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertComputeOutputBindingsShape(row.bindings)
      return { ref: bindingsRef, bindings: row.bindings }
    })
  }
}

interface ArtifactRow extends QueryResultRow {
  artifact: ComputeResultArtifact
}

/** Real PostgreSQL implementation of the immutable result-artifact wrapper store. */
export class PostgresComputeResultArtifactStore implements ComputeResultArtifactStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putArtifact(
    scopeRef: ScopeRef,
    artifactRef: ResourceRef,
    artifact: ComputeResultArtifact,
    ctx: ToolContext,
  ): Promise<void> {
    assertComputeResultArtifactShape(artifact)
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.compute_result_artifacts
           (tenant_id, space_id, artifact_id, version, digest, invocation_id, output_digest, artifact, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, artifact_id, version, digest) DO NOTHING
         RETURNING artifact`,
        [
          artifactRef.id,
          artifactRef.version,
          artifactRef.digest,
          artifact.invocationId,
          artifact.outputDigest,
          JSON.stringify(artifact),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows.length > 0) return
      const existing = await query.query<ArtifactRow & { same_content: boolean }>(
        `SELECT artifact, (artifact = $4::jsonb) AS same_content
           FROM agent_platform.compute_result_artifacts
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND artifact_id = $1 AND version = $2 AND digest = $3`,
        [artifactRef.id, artifactRef.version, artifactRef.digest, JSON.stringify(artifact)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `compute result artifact ${artifactRef.id} already exists with different content`,
        )
      }
    })
  }

  async getArtifact(
    scopeRef: ScopeRef,
    artifactRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedComputeResultArtifact | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ArtifactRow>(
        `SELECT artifact FROM agent_platform.compute_result_artifacts
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND artifact_id = $1 AND version = $2 AND digest = $3`,
        [artifactRef.id, artifactRef.version, artifactRef.digest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertComputeResultArtifactShape(row.artifact)
      return { ref: artifactRef, artifact: row.artifact }
    })
  }
}
