import { createHash } from 'node:crypto'
import { isToolContext } from '@ontology/contracts'
import type {
  ControlAppendEventRequest,
  ControlAppendEventResponse,
  ControlReadProjectionRequest,
  ControlRepository,
  ControlTransactionRequest,
  ProjectionState,
  ScopeRef,
  SourceWatermark,
  ToolContext,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'
import type { ControlQueryResult, ControlScope } from './database'
import { ControlStorageError } from './errors'

/**
 * Host-registered control operation. `ControlTransactionRequest.operations` is a
 * list of opaque JSON documents `{"op": ..., "params": ...}`; later nodes
 * register their handlers here instead of widening the port contract.
 */
export interface ControlOperationContext {
  query<T extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<ControlQueryResult<T>>
}

export type ControlOperationHandler = (
  context: ControlOperationContext,
  params: unknown,
) => Promise<void>

export interface ControlPostgresRepositoryOptions {
  readonly operations?: ReadonlyMap<string, ControlOperationHandler>
}

interface ProjectionRow extends QueryResultRow {
  generation: string
  watermark_kind: SourceWatermark['kind']
  watermark_value: string
  dirty: boolean
}

interface ParsedControlOperation {
  readonly op: string
  readonly params: unknown
}

/**
 * Scope is taken from the trusted ToolContext, never from the request body. A
 * model that supplies a different `scopeRef` is rejected before any SQL runs.
 */
function resolveControlScope(scopeRef: ScopeRef, ctx: ToolContext): ControlScope {
  if (!isToolContext(ctx)) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const trustedTenant = ctx.principal.tenantId
  const trustedSpace = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== trustedTenant) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== trustedTenant || scopeRef.spaceId !== trustedSpace) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return { tenantId: trustedTenant, spaceId: trustedSpace }
}

function digestOperations(operations: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(operations), 'utf8').digest('hex')
}

function parseControlOperation(raw: string): ParsedControlOperation {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ControlStorageError('INVALID_OPERATION', 'control operation must be a JSON document', {
      cause: error,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ControlStorageError('INVALID_OPERATION', 'control operation must be a JSON object')
  }
  const op = (parsed as { op?: unknown }).op
  if (typeof op !== 'string' || op.length === 0) {
    throw new ControlStorageError('INVALID_OPERATION', 'control operation requires a non-empty "op" field')
  }
  return { op, params: (parsed as { params?: unknown }).params }
}

export class ControlPostgresRepository implements ControlRepository {
  readonly #database: ControlPostgresDatabase
  readonly #operations: ReadonlyMap<string, ControlOperationHandler>

  constructor(database: ControlPostgresDatabase, options?: ControlPostgresRepositoryOptions) {
    this.#database = database
    this.#operations = options?.operations ?? new Map<string, ControlOperationHandler>()
  }

  async transaction(request: ControlTransactionRequest, ctx: ToolContext): Promise<void> {
    const scope = resolveControlScope(request.scopeRef, ctx)
    if (request.operations.length === 0) {
      throw new ControlStorageError('INVALID_OPERATION', 'a control transaction needs at least one operation')
    }
    const operations = request.operations.map(parseControlOperation)
    const idempotencyKey = request.idempotencyKey
    const requestDigest = idempotencyKey === undefined ? undefined : digestOperations(request.operations)
    await this.#database.withIdentityScope(scope, async (client) => {
      if (idempotencyKey !== undefined && requestDigest !== undefined) {
        const claimed = await client.query<{ request_digest: string }>(
          `INSERT INTO agent_platform.control_transactions
             (tenant_id, space_id, idempotency_key, request_digest)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
           RETURNING request_digest`,
          [scope.tenantId, scope.spaceId, idempotencyKey, requestDigest],
        )
        if (claimed.rows[0] === undefined) {
          const existing = await client.query<{ request_digest: string }>(
            `SELECT request_digest
               FROM agent_platform.control_transactions
              WHERE tenant_id = $1 AND space_id = $2 AND idempotency_key = $3`,
            [scope.tenantId, scope.spaceId, idempotencyKey],
          )
          const previous = existing.rows[0]
          if (previous === undefined || previous.request_digest !== requestDigest) {
            throw new ControlStorageError(
              'IDEMPOTENCY_CONFLICT',
              'the idempotency key was already used with a different payload',
            )
          }
          return
        }
      }

      const context: ControlOperationContext = {
        query: async <T extends QueryResultRow = Record<string, unknown>>(
          text: string,
          values?: unknown[],
        ) => {
          const result = await client.query<T>(text, values)
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }
      for (const operation of operations) {
        const handler = this.#operations.get(operation.op)
        if (handler === undefined) {
          throw new ControlStorageError(
            'UNSUPPORTED_OPERATION',
            `no handler is registered for control operation ${operation.op}`,
          )
        }
        await handler(context, operation.params)
      }
    })
  }

  async readProjection(
    request: ControlReadProjectionRequest,
    ctx: ToolContext,
  ): Promise<ProjectionState> {
    const scope = resolveControlScope(request.scopeRef, ctx)
    return this.#database.withIdentityScope(
      scope,
      async (client) => {
        const result = await client.query<ProjectionRow>(
          `SELECT generation, watermark_kind, watermark_value, dirty
             FROM agent_platform.projection_state
            WHERE tenant_id = $1 AND space_id = $2 AND projection_ref = $3`,
          [scope.tenantId, scope.spaceId, request.projectionRef.id],
        )
        const row = result.rows[0]
        if (row === undefined) {
          throw new ControlStorageError(
            'PROJECTION_NOT_FOUND',
            `projection ${request.projectionRef.id} is not visible in the requested scope`,
          )
        }
        return {
          scopeRef: { tenantId: scope.tenantId, spaceId: scope.spaceId },
          generation: row.generation,
          watermark: { kind: row.watermark_kind, value: row.watermark_value },
          dirty: row.dirty,
        }
      },
      { readOnly: true },
    )
  }

  async appendEvent(
    request: ControlAppendEventRequest,
    ctx: ToolContext,
  ): Promise<ControlAppendEventResponse> {
    const scope = resolveControlScope(request.scopeRef, ctx)
    return this.#database.withIdentityScope(scope, async (client) => {
      await client.query(
        `INSERT INTO agent_platform.event_streams (tenant_id, space_id, stream_ref, last_seq)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (tenant_id, space_id, stream_ref) DO NOTHING`,
        [scope.tenantId, scope.spaceId, request.streamRef],
      )

      // Locking the stream row serialises concurrent appends to the same stream,
      // so the idempotency check below cannot race a second writer.
      const locked = await client.query<{ last_seq: string }>(
        `SELECT last_seq
           FROM agent_platform.event_streams
          WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3
          FOR UPDATE`,
        [scope.tenantId, scope.spaceId, request.streamRef],
      )
      if (locked.rows[0] === undefined) {
        throw new ControlStorageError('SCOPE_MISMATCH', 'event stream is not visible in the requested scope')
      }

      const existing = await client.query<{ recorded_seq: string }>(
        `SELECT recorded_seq
           FROM agent_platform.semantic_events
          WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3 AND idempotency_key = $4`,
        [scope.tenantId, scope.spaceId, request.streamRef, request.idempotencyKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow !== undefined) {
        return { recordedSeq: existingRow.recorded_seq, appended: false }
      }

      const advanced = await client.query<{ last_seq: string }>(
        `UPDATE agent_platform.event_streams
            SET last_seq = last_seq + 1
          WHERE tenant_id = $1 AND space_id = $2 AND stream_ref = $3
          RETURNING last_seq`,
        [scope.tenantId, scope.spaceId, request.streamRef],
      )
      const advancedRow = advanced.rows[0]
      if (advancedRow === undefined) {
        throw new ControlStorageError('SCOPE_MISMATCH', 'event stream disappeared during append')
      }

      await client.query(
        `INSERT INTO agent_platform.semantic_events
           (tenant_id, space_id, stream_ref, recorded_seq, payload_digest, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          scope.tenantId,
          scope.spaceId,
          request.streamRef,
          advancedRow.last_seq,
          request.payloadDigest,
          request.idempotencyKey,
        ],
      )
      return { recordedSeq: advancedRow.last_seq, appended: true }
    })
  }
}
