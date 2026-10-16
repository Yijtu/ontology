import type { PoolClient, QueryResultRow } from 'pg'
import { CandidateCommitError, isToolContext } from '@ontology/contracts'
import type {
  ActionCandidateVersion,
  AssetCandidateBatch,
  AssetCandidateInsertGuard,
  AssetCandidateInsertResult,
  AssetCandidateVersion,
  CandidateCommitPort,
  CandidateCommitRequest,
  CandidateCommitResult,
  CandidateCommitTransaction,
  CandidateSource,
  CandidateSourceRecord,
  CandidateSubmissionRecord,
  RuleCandidateVersion,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { ControlPostgresDatabase } from './database'
import { PostgresAssetCandidateStore } from './asset-candidate-store'
import { PostgresCandidateSourceStore } from './candidate-source-store'
import { PostgresRuleActionCandidateStore } from './rule-action-candidate-store'
import { PostgresCandidateSubmissionStore } from './candidate-submission-store'

interface RunStateRow extends QueryResultRow {
  state: string
}

interface DraftRow extends QueryResultRow {
  head_revision: string
  state: string
  digest: string | null
}

interface AdmissionRow extends QueryResultRow {
  state: string
}

interface DispatchRow extends QueryResultRow {
  run_id: string
  state: string
  lease_owner_id: string | null
  attempt: string
  lease_active: boolean
}

interface ReservationRow extends QueryResultRow {
  status: string
  candidates: number
}

const NON_ACCEPTING_STATES: readonly string[] = ['cancelling', 'cancelled', 'failed', 'blocked', 'published']

export interface PostgresCandidateCommitStoreDependencies {
  readonly database: ControlPostgresDatabase
  readonly assetCandidates: PostgresAssetCandidateStore
  readonly sources: PostgresCandidateSourceStore
  readonly ruleActions: PostgresRuleActionCandidateStore
  readonly receipts: PostgresCandidateSubmissionStore
}

/**
 * The atomic candidate-commit store (design §7, S08). One transaction re-checks the run cancel
 * state, the durable dispatch owner/attempt fence, the authorization admission, the frozen draft
 * revision and the candidate quota, then runs the caller's domain writes (candidate, source links,
 * receipt) on the same connection. A failure anywhere rolls the whole commit back, so a candidate
 * is never left without its receipt and no candidate is written after a cancel or a lost lease.
 */
export class PostgresCandidateCommitStore implements CandidateCommitPort {
  readonly #database: ControlPostgresDatabase
  readonly #assetCandidates: PostgresAssetCandidateStore
  readonly #sources: PostgresCandidateSourceStore
  readonly #ruleActions: PostgresRuleActionCandidateStore
  readonly #receipts: PostgresCandidateSubmissionStore

  constructor(dependencies: PostgresCandidateCommitStoreDependencies) {
    this.#database = dependencies.database
    this.#assetCandidates = dependencies.assetCandidates
    this.#sources = dependencies.sources
    this.#ruleActions = dependencies.ruleActions
    this.#receipts = dependencies.receipts
  }

  async commit(
    scopeRef: ScopeRef,
    request: CandidateCommitRequest,
    ctx: ToolContext,
    run: (tx: CandidateCommitTransaction) => Promise<CandidateSubmissionRecord>,
  ): Promise<CandidateCommitResult> {
    if (!isToolContext(ctx)) throw new CandidateCommitError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    if (ctx.allowedResources.tenantId !== ctx.principal.tenantId
      || scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new CandidateCommitError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId }, async (client) => {
      await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])

      // A repeated command must return the original receipt. Check before the fence so a replay of
      // an already-committed command still answers, even if the run has since been cancelled.
      const existing = await this.#receipts.findByKey(scopeRef, { runId: request.runId, idempotencyKey: request.idempotencyKey }, ctx, client)
      if (existing !== undefined) {
        if (existing.commandDigest !== request.commandDigest) {
          throw new CandidateCommitError('STORE_FAILED', 'the idempotency key was reused for a different submission')
        }
        return { record: existing, replayed: true }
      }

      await this.#assertFence(client, scopeRef, request)

      const tx = this.#transaction(scopeRef, ctx, client)
      const record = await run(tx)
      await this.#writeFenceRow(client, scopeRef, request, record)
      return { record, replayed: false }
    })
  }

  async #assertFence(client: PoolClient, scopeRef: ScopeRef, request: CandidateCommitRequest): Promise<void> {
    const binding = request.binding

    const run = await client.query<RunStateRow>(
      `SELECT state FROM agent_platform.runs
        WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid
        FOR UPDATE`,
      [scopeRef.tenantId, scopeRef.spaceId, binding.runId],
    )
    const runRow = run.rows[0]
    if (runRow === undefined) {
      throw new CandidateCommitError('SCOPE_MISMATCH', 'the run is not visible in this scope')
    }
    if (NON_ACCEPTING_STATES.includes(runRow.state)) {
      throw new CandidateCommitError('RUN_CANCELLED', `the run is ${runRow.state} and cannot accept a candidate`)
    }

    const draft = await client.query<DraftRow>(
      `SELECT workspace.head_revision::text AS head_revision, workspace.state,
              draft.digest AS digest
         FROM agent_platform.industry_workspaces AS workspace
         LEFT JOIN agent_platform.asset_draft_versions AS draft
           ON draft.tenant_id = workspace.tenant_id AND draft.space_id = workspace.space_id
          AND draft.workspace_id = workspace.workspace_id AND draft.revision = $3::bigint
        WHERE workspace.tenant_id = $1::uuid AND workspace.space_id = $2::uuid AND workspace.workspace_id = $4::uuid
        FOR UPDATE OF workspace`,
      [scopeRef.tenantId, scopeRef.spaceId, binding.draftRevision, binding.workspaceId],
    )
    const draftRow = draft.rows[0]
    if (draftRow === undefined) {
      throw new CandidateCommitError('DRAFT_CHANGED', 'the run workspace is not visible in this scope')
    }
    if (draftRow.state === 'archived') {
      throw new CandidateCommitError('DRAFT_CHANGED', 'the run workspace is archived')
    }
    if (draftRow.head_revision !== binding.draftRevision || draftRow.digest !== binding.draftDigest) {
      throw new CandidateCommitError('DRAFT_CHANGED', 'the run draft moved since the run was admitted')
    }

    const admission = await client.query<AdmissionRow>(
      `SELECT state FROM agent_platform.research_run_admission
        WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND run_id = $3::uuid`,
      [scopeRef.tenantId, scopeRef.spaceId, binding.runId],
    )
    if (admission.rows[0]?.state !== 'ready') {
      throw new CandidateCommitError('AUTHORIZATION_REVOKED', 'the research run authorization is no longer in force')
    }

    if (request.fence !== undefined) {
      const dispatch = await client.query<DispatchRow>(
        `SELECT run_id, state, lease_owner_id, attempt::text AS attempt,
                lease_expires_at > clock_timestamp() AS lease_active
           FROM agent_platform.workflow_dispatches
          WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND dispatch_id = $3::uuid
          FOR UPDATE`,
        [scopeRef.tenantId, scopeRef.spaceId, request.fence.dispatchId],
      )
      const lease = dispatch.rows[0]
      if (
        lease === undefined ||
        lease.run_id !== binding.runId ||
        lease.state !== 'leased' ||
        lease.lease_owner_id !== request.fence.ownerId ||
        lease.attempt !== request.fence.attempt ||
        !lease.lease_active
      ) {
        throw new CandidateCommitError('LEASE_LOST', 'the dispatch lease is no longer held by this worker')
      }
    }

    if (request.ledgerId !== undefined && request.reservationId !== undefined) {
      const reservation = await client.query<ReservationRow>(
        `SELECT status, candidates FROM agent_platform.budget_reservations
          WHERE tenant_id = $1::uuid AND space_id = $2::uuid AND ledger_id = $3::uuid AND reservation_id = $4::uuid
          FOR SHARE`,
        [scopeRef.tenantId, scopeRef.spaceId, request.ledgerId, request.reservationId],
      )
      const row = reservation.rows[0]
      if (row === undefined || row.status !== 'reserved' || row.candidates <= 0) {
        throw new CandidateCommitError('BUDGET_EXHAUSTED', 'the run candidate budget reservation is not available')
      }
    }
  }

  #transaction(scopeRef: ScopeRef, ctx: ToolContext, client: PoolClient): CandidateCommitTransaction {
    return {
      insertDefinitionBatch: (
        batch: AssetCandidateBatch,
        candidates: readonly AssetCandidateVersion[],
        guard?: AssetCandidateInsertGuard,
      ): Promise<AssetCandidateInsertResult> =>
        this.#assetCandidates.insertBatch(scopeRef, batch, candidates, ctx, guard, client),
      putSource: (input: { readonly source: CandidateSource; readonly idempotencyKey: string }): Promise<CandidateSourceRecord> =>
        this.#sources.putSource(scopeRef, input, ctx, client),
      insertRuleCandidate: (candidate: RuleCandidateVersion): Promise<RuleCandidateVersion> =>
        this.#ruleActions.insert(scopeRef, candidate, ctx, client) as Promise<RuleCandidateVersion>,
      insertActionCandidate: (candidate: ActionCandidateVersion): Promise<ActionCandidateVersion> =>
        this.#ruleActions.insert(scopeRef, candidate, ctx, client) as Promise<ActionCandidateVersion>,
      record: (record: CandidateSubmissionRecord) => this.#receipts.record(scopeRef, { record }, ctx, client),
    }
  }

  async #writeFenceRow(
    client: PoolClient,
    scopeRef: ScopeRef,
    request: CandidateCommitRequest,
    record: CandidateSubmissionRecord,
  ): Promise<void> {
    const candidateIds = record.receipt.accepted.map((entry) => entry.candidateId)
    await client.query(
      `INSERT INTO agent_platform.research_candidate_commit_fences
         (tenant_id, space_id, run_id, idempotency_key, command_digest, workspace_id, draft_revision,
          draft_digest, ledger_id, reservation_id, dispatch_id, lease_owner_id, attempt, candidate_ids, recorded_at)
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::bigint, $8, $9::uuid, $10::uuid, $11::uuid, $12::uuid,
         $13::bigint, $14::jsonb, $15::timestamptz)
       ON CONFLICT (tenant_id, space_id, run_id, idempotency_key) DO NOTHING`,
      [
        scopeRef.tenantId, scopeRef.spaceId, request.runId, request.idempotencyKey, request.commandDigest,
        request.binding.workspaceId, request.binding.draftRevision, request.binding.draftDigest,
        request.ledgerId ?? null, request.reservationId ?? null,
        request.fence?.dispatchId ?? null, request.fence?.ownerId ?? null, request.fence?.attempt ?? null,
        JSON.stringify(candidateIds), record.recordedAt,
      ],
    )
  }
}
