import { ControlStorageError } from './errors'
import { isToolContext } from '@ontology/contracts'
import type { RevisionString, RunManifest, ToolContext, Uuid, VerificationRecord, VerificationStorePort, WorkflowInputManifest, WorkflowManifestStore, WorkflowRunState } from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

function scope(ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'a consistent trusted workflow scope is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function value<T>(raw: unknown): T {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function conflict(message: string): never {
  throw new ControlStorageError('IDEMPOTENCY_CONFLICT', message)
}

function revisionNumber(revision: string): bigint {
  if (!/^(0|[1-9]\d*)$/u.test(revision)) return conflict('workflow revision is not a canonical non-negative integer')
  return BigInt(revision)
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

/**
 * Durable controller manifests and verdicts. Input manifests use their monotonic revision as
 * a compare-and-swap token; mutable run state has an explicit bigint CAS revision. A stale
 * controller receives IDEMPOTENCY_CONFLICT instead of silently overwriting another owner.
 */
export class PostgresWorkflowStore implements WorkflowManifestStore, VerificationStorePort {
  readonly #db: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#db = database
  }

  async saveRunManifest(manifest: RunManifest, ctx: ToolContext): Promise<RunManifest> {
    const s = scope(ctx)
    return this.#db.withIdentityScope(s, async (client) => {
      const inserted = await client.query<{ manifest: unknown } & QueryResultRow>(
        `INSERT INTO agent_platform.workflow_run_manifests (tenant_id, space_id, run_id, manifest)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, $2::jsonb)
         ON CONFLICT (tenant_id, space_id, run_id) DO NOTHING
         RETURNING manifest`,
        [manifest.runId, JSON.stringify(manifest)],
      )
      if (inserted.rows[0] !== undefined) return value<RunManifest>(inserted.rows[0].manifest)
      const prior = await client.query<{ manifest: unknown } & QueryResultRow>(
        `SELECT manifest FROM agent_platform.workflow_run_manifests WHERE run_id = $1`,
        [manifest.runId],
      )
      if (prior.rows[0] === undefined) return conflict(`workflow run manifest ${manifest.runId} was not stored`)
      const stored = value<RunManifest>(prior.rows[0].manifest)
      if (!jsonEqual(stored, manifest)) return conflict(`workflow run manifest ${manifest.runId} is immutable`)
      return stored
    })
  }

  getRunManifest(runId: Uuid, ctx: ToolContext): Promise<RunManifest | undefined> {
    return this.#readOne<RunManifest>('workflow_run_manifests', 'manifest', 'run_id', runId, ctx)
  }

  async saveInputManifest(manifest: WorkflowInputManifest, ctx: ToolContext): Promise<WorkflowInputManifest> {
    const s = scope(ctx)
    const incomingRevision = revisionNumber(manifest.revision)
    if (incomingRevision < 1n) return conflict('input manifest revision must start at 1')
    return this.#db.withIdentityScope(s, async (client) => {
      const existing = await client.query<{ manifest: unknown } & QueryResultRow>(
        `SELECT manifest FROM agent_platform.workflow_input_manifests WHERE manifest_id = $1`,
        [manifest.manifestId],
      )
      if (existing.rows[0] === undefined && incomingRevision !== 1n) {
        return conflict(`new input manifest ${manifest.manifestId} must start at revision 1`)
      }
      const inserted = await client.query<{ manifest: unknown } & QueryResultRow>(
        `INSERT INTO agent_platform.workflow_input_manifests (tenant_id, space_id, manifest_id, run_id, manifest)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, space_id, manifest_id) DO UPDATE
           SET manifest = EXCLUDED.manifest, updated_at = now()
           WHERE agent_platform.workflow_input_manifests.run_id = EXCLUDED.run_id
             AND (agent_platform.workflow_input_manifests.manifest->>'revision')::numeric = $4::numeric
         RETURNING manifest`,
        [manifest.manifestId, manifest.runId, JSON.stringify(manifest), (incomingRevision - 1n).toString()],
      )
      if (inserted.rows[0] !== undefined) return value<WorkflowInputManifest>(inserted.rows[0].manifest)
      const prior = await client.query<{ manifest: unknown } & QueryResultRow>(
        `SELECT manifest FROM agent_platform.workflow_input_manifests WHERE manifest_id = $1`,
        [manifest.manifestId],
      )
      if (prior.rows[0] === undefined) return conflict(`input manifest ${manifest.manifestId} was not stored`)
      const stored = value<WorkflowInputManifest>(prior.rows[0].manifest)
      if (stored.runId === manifest.runId && jsonEqual(stored, manifest)) return stored
      return conflict(`input manifest ${manifest.manifestId} changed while this revision was being saved`)
    })
  }

  getInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest | undefined> {
    return this.#readOne<WorkflowInputManifest>('workflow_input_manifests', 'manifest', 'manifest_id', manifestId, ctx)
  }

  async saveRunState(state: WorkflowRunState, expectedRevision: RevisionString, ctx: ToolContext): Promise<WorkflowRunState> {
    const s = scope(ctx)
    const expected = revisionNumber(expectedRevision)
    const next = expected + 1n
    if (revisionNumber(state.revision) !== next) return conflict('workflow state revision must advance by exactly one')
    return this.#db.withIdentityScope(s, async (client) => {
      if (expected !== 0n) {
        const exists = await client.query<{ revision: string } & QueryResultRow>(
          `SELECT revision::text AS revision FROM agent_platform.workflow_run_states WHERE run_id = $1`,
          [state.runId],
        )
        if (exists.rows[0] === undefined) return conflict(`workflow state ${state.runId} has no revision ${expectedRevision}`)
      }
      const saved = await client.query<{ state: unknown; revision: string } & QueryResultRow>(
        `INSERT INTO agent_platform.workflow_run_states (tenant_id, space_id, run_id, state, revision)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, $2::jsonb, $3::bigint)
         ON CONFLICT (tenant_id, space_id, run_id) DO UPDATE
           SET state = EXCLUDED.state, revision = EXCLUDED.revision, updated_at = now()
           WHERE agent_platform.workflow_run_states.revision = $4::bigint
         RETURNING state, revision::text AS revision`,
        [state.runId, JSON.stringify(state), next.toString(), expected.toString()],
      )
      if (saved.rows[0] !== undefined) return value<WorkflowRunState>(saved.rows[0].state)
      const prior = await client.query<{ state: unknown; revision: string } & QueryResultRow>(
        `SELECT state, revision::text AS revision FROM agent_platform.workflow_run_states WHERE run_id = $1`,
        [state.runId],
      )
      if (prior.rows[0] !== undefined && BigInt(prior.rows[0].revision) === next && jsonEqual(value<WorkflowRunState>(prior.rows[0].state), state)) {
        return value<WorkflowRunState>(prior.rows[0].state)
      }
      return conflict(`workflow state ${state.runId} changed from expected revision ${expectedRevision}`)
    })
  }

  async getRunState(runId: Uuid, ctx: ToolContext): Promise<WorkflowRunState | undefined> {
    const row = await this.#readRaw<{ state: unknown; revision: string }>('workflow_run_states', 'state, revision::text AS revision', 'run_id', runId, ctx)
    if (row === undefined) return undefined
    const state = value<WorkflowRunState>(row.state)
    return { ...state, revision: row.revision }
  }

  async record(record: VerificationRecord, ctx: ToolContext): Promise<void> {
    const s = scope(ctx)
    await this.#db.withIdentityScope(s, async (client) => {
      const inserted = await client.query(
        `INSERT INTO agent_platform.workflow_verifications (tenant_id, space_id, verification_id, run_id, record)
         VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.space_id')::uuid, $1, $2, $3::jsonb)
         ON CONFLICT (tenant_id, space_id, verification_id) DO NOTHING`,
        [record.verification.verificationId, record.runId, JSON.stringify(record)],
      )
      if ((inserted.rowCount ?? 0) > 0) return
      const prior = await client.query<{ record: unknown } & QueryResultRow>(
        `SELECT record FROM agent_platform.workflow_verifications WHERE verification_id = $1`,
        [record.verification.verificationId],
      )
      if (prior.rows[0] === undefined || !jsonEqual(value<VerificationRecord>(prior.rows[0].record), record)) {
        conflict(`verification ${record.verification.verificationId} conflicts with its immutable record`)
      }
    })
  }

  find(verificationId: Uuid, ctx: ToolContext): Promise<VerificationRecord | undefined> {
    return this.#readOne<VerificationRecord>('workflow_verifications', 'record', 'verification_id', verificationId, ctx)
  }

  async #readOne<T>(table: string, column: string, key: string, id: Uuid, ctx: ToolContext): Promise<T | undefined> {
    const raw = await this.#readRaw<{ value: unknown }>(table, `${column} AS value`, key, id, ctx)
    return raw === undefined ? undefined : value<T>(raw.value)
  }

  async #readRaw<T extends QueryResultRow>(table: string, columns: string, key: string, id: Uuid, ctx: ToolContext): Promise<T | undefined> {
    const s = scope(ctx)
    return this.#db.withIdentityScope(s, async (client) => {
      const result = await client.query<T>(
        `SELECT ${columns} FROM agent_platform.${table} WHERE ${key} = $1`,
        [id],
      )
      return result.rows[0]
    }, { readOnly: true })
  }
}
