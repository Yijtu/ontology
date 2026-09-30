import { AnswerStoreError, isAnswerDraftV3Body, isPublishedAnswerBody, isToolContext } from '@ontology/contracts'
import type {
  AnswerStorePort,
  PublicationKind,
  PublishedAnswer,
  RecordAnswerInput,
  SemanticReviewDisposition,
  RunState,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface AnswerRow extends QueryResultRow {
  answer_id: string
  run_id: string
  draft_id: string
  verification_id: string
  content_hash: string
  evidence_manifest_hash: string
  scenario_manifest_hash: string
  publication_kind: PublicationKind
  as_of: Date | null
  limitations: string[]
  body: unknown | null
  semantic_review: SemanticReviewDisposition | null
  body_missing: boolean
  published_at: Date
}

interface RunStateRow extends QueryResultRow {
  state: RunState
  revision: string
}

interface DispatchFenceRow extends QueryResultRow {
  run_id: string
  state: string
  lease_owner_id: string | null
  attempt: string
  revision: string
  lease_active: boolean
}

interface EvidencePinRow extends QueryResultRow {
  kind: string
  result_digest: string
  envelope_digest: string
  revision: string
}

const ANSWER_COLUMNS =
  'answer_id, run_id, draft_id, verification_id, content_hash, evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations, body, semantic_review, (body IS NULL) AS body_missing, published_at'

function scopeOf(ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx)) {
    throw new AnswerStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new AnswerStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function toAnswer(row: AnswerRow): PublishedAnswer {
  const body = row.body
  if (row.body_missing && body !== null) {
    throw new AnswerStoreError('ANSWER_PERSIST_FAILED', `stored answer ${row.answer_id} has inconsistent body metadata`)
  }
  let bodyField: Pick<PublishedAnswer, 'body' | 'v3Body' | 'bodyUnavailableReason'>
  if (row.body_missing) {
    bodyField = { bodyUnavailableReason: 'legacy_metadata_only' }
  } else if (isPublishedAnswerBody(body)) {
    bodyField = { body }
  } else if (isAnswerDraftV3Body(body)) {
    bodyField = { v3Body: body }
  } else {
    throw new AnswerStoreError('ANSWER_PERSIST_FAILED', `stored answer ${row.answer_id} has a malformed body`)
  }
  return {
    answerId: row.answer_id,
    runId: row.run_id,
    draftId: row.draft_id,
    verificationId: row.verification_id,
    contentHash: row.content_hash,
    evidenceManifestHash: row.evidence_manifest_hash,
    scenarioManifestHash: row.scenario_manifest_hash,
    publicationKind: row.publication_kind,
    ...(row.as_of === null ? {} : { asOf: row.as_of.toISOString() }),
    limitations: row.limitations,
    ...(row.semantic_review === null ? {} : { semanticReview: row.semantic_review }),
    ...bodyField,
    publishedAt: row.published_at.toISOString(),
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function samePublication(left: PublishedAnswer, right: PublishedAnswer): boolean {
  const sameAsOf = left.asOf === undefined || right.asOf === undefined
    ? left.asOf === right.asOf
    : Date.parse(left.asOf) === Date.parse(right.asOf)
  return left.runId === right.runId && left.draftId === right.draftId && left.verificationId === right.verificationId &&
    left.contentHash === right.contentHash && left.evidenceManifestHash === right.evidenceManifestHash &&
    left.scenarioManifestHash === right.scenarioManifestHash && left.publicationKind === right.publicationKind &&
    sameAsOf && canonical(left.limitations) === canonical(right.limitations) && canonical(left.body) === canonical(right.body) &&
    canonical(left.v3Body) === canonical(right.v3Body) &&
    canonical(left.semanticReview) === canonical(right.semanticReview)
}

/**
 * Real PostgreSQL published-answer store (SPEC D7.4, C6, INV-09).
 *
 * `record` is one transaction: it locks the run row, re-checks that the run is still in the
 * expected state at the expected revision, and only then inserts the answer. A run cancelled
 * between verification and publication therefore cannot leave an answer behind. The insert is
 * idempotent per run, so a retry of the same publication returns the stored answer unchanged.
 *
 * Every statement runs as the non-owner application role with the trusted scope set via
 * `SET LOCAL`, so RLS applies and a lookup in another tenant/space returns nothing.
 */
export class PostgresAnswerStore implements AnswerStorePort {
  readonly #database: ControlPostgresDatabase
  readonly #requireWorkflowDispatchFence: boolean

  constructor(database: ControlPostgresDatabase, options: { readonly requireWorkflowDispatchFence?: boolean } = {}) {
    this.#database = database
    this.#requireWorkflowDispatchFence = options.requireWorkflowDispatchFence ?? false
  }

  async record(input: RecordAnswerInput, ctx: ToolContext): Promise<PublishedAnswer> {
    const body = input.answer.body ?? input.answer.v3Body
    if (body === undefined) throw new AnswerStoreError('ANSWER_BODY_REQUIRED', 'new answer publications must persist the verified body')
    if (!isPublishedAnswerBody(body) && !isAnswerDraftV3Body(body)) {
      throw new AnswerStoreError('ANSWER_BODY_REQUIRED', 'new answer publications must contain a versioned body')
    }
    const scope = scopeOf(ctx)
    return this.#database.withIdentityScope(scope, async (client) => {
      const run = await client.query<RunStateRow>(
        `SELECT state, revision
           FROM agent_platform.runs
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1
          FOR UPDATE`,
        [input.answer.runId],
      )
      const current = run.rows[0]
      if (current === undefined) {
        throw new AnswerStoreError(
          'RUN_NOT_PUBLISHABLE',
          `run ${input.answer.runId} is not visible in this scope`,
        )
      }
      if (current.state !== input.expectedRunState || current.revision !== input.expectedRunRevision) {
        throw new AnswerStoreError(
          'RUN_NOT_PUBLISHABLE',
          `run ${input.answer.runId} is ${current.state} at revision ${current.revision} and is not publishable`,
        )
      }

      const fence = input.workflowDispatchFence
      if (fence === undefined && this.#requireWorkflowDispatchFence) {
        throw new AnswerStoreError(
          'RUN_NOT_PUBLISHABLE',
          'publication requires the active durable workflow dispatch lease',
        )
      }
      if (fence !== undefined) {
        const dispatch = await client.query<DispatchFenceRow>(
          `SELECT dispatch.run_id, dispatch.state, dispatch.lease_owner_id,
                  dispatch.attempt::text AS attempt, dispatch.revision::text AS revision,
                  dispatch.lease_expires_at > clock_timestamp() AS lease_active
             FROM agent_platform.workflow_dispatches AS dispatch
            WHERE dispatch.tenant_id = current_setting('app.tenant_id')::uuid
              AND dispatch.space_id = current_setting('app.space_id')::uuid
              AND dispatch.dispatch_id = $1::uuid
            FOR UPDATE`,
          [fence.dispatchId],
        )
        const lease = dispatch.rows[0]
        if (
          lease === undefined ||
          lease.run_id !== input.answer.runId ||
          lease.state !== 'leased' ||
          lease.lease_owner_id !== fence.ownerId ||
          lease.attempt !== fence.attempt ||
          lease.revision !== fence.expectedRevision ||
          !lease.lease_active
        ) {
          throw new AnswerStoreError(
            'RUN_NOT_PUBLISHABLE',
            'the workflow dispatch lease is no longer active for this publication',
          )
        }
      }

      // Publication transaction fence (SPEC v0.3a §EX-7.2): re-read every evidence dependency
      // the verified draft rests on in the *same* transaction as the answer insert. A
      // dependency retracted, edited or made unreadable between the validity check and this
      // commit rejects the answer, so nothing partial is published. `FOR SHARE` blocks a
      // concurrent retraction from committing underneath the write.
      for (const pin of input.dependencyPins ?? []) {
        const dependency = await client.query<EvidencePinRow>(
          `SELECT kind, result_digest, envelope_digest, revision::text AS revision
             FROM agent_platform.evidence_records
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND evidence_id = $1
            FOR SHARE`,
          [pin.evidenceRef.id],
        )
        const row = dependency.rows[0]
        if (
          row === undefined ||
          row.kind !== pin.evidenceKind ||
          row.result_digest !== pin.resultDigest ||
          row.envelope_digest !== pin.envelopeDigest ||
          row.revision !== pin.revision
        ) {
          throw new AnswerStoreError(
            'RUN_NOT_PUBLISHABLE',
            `a verified evidence dependency of run ${input.answer.runId} changed before publication committed`,
          )
        }
      }

      try {
        await client.query(
          `INSERT INTO agent_platform.answer_publications
             (tenant_id, space_id, run_id, answer_id, draft_id, verification_id, content_hash,
              evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations,
              body, semantic_review, published_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb, $11::jsonb, $12::jsonb, $13::timestamptz
           )
           ON CONFLICT (tenant_id, space_id, run_id) DO NOTHING`,
          [
            input.answer.runId,
            input.answer.answerId,
            input.answer.draftId,
            input.answer.verificationId,
            input.answer.contentHash,
            input.answer.evidenceManifestHash,
            input.answer.scenarioManifestHash,
            input.answer.publicationKind,
            input.answer.asOf ?? null,
            JSON.stringify(input.answer.limitations),
            JSON.stringify(body),
            input.answer.semanticReview === undefined ? null : JSON.stringify(input.answer.semanticReview),
            input.answer.publishedAt,
          ],
        )
      } catch (error) {
        throw new AnswerStoreError(
          'ANSWER_PERSIST_FAILED',
          `could not persist the answer for run ${input.answer.runId}`,
          { cause: error },
        )
      }

      const stored = await client.query<AnswerRow>(
        `SELECT ${ANSWER_COLUMNS}
           FROM agent_platform.answer_publications
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND run_id = $1`,
        [input.answer.runId],
      )
      const row = stored.rows[0]
      if (row === undefined) {
        throw new AnswerStoreError(
          'ANSWER_PERSIST_FAILED',
          `the answer for run ${input.answer.runId} was not stored`,
        )
      }
      const answer = toAnswer(row)
      if (!samePublication(answer, input.answer)) {
        throw new AnswerStoreError('ANSWER_IDEMPOTENCY_CONFLICT', `run ${input.answer.runId} already has a different immutable answer`)
      }
      return answer
    })
  }

  async findByRun(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    const scope = scopeOf(ctx)
    return this.#database.withIdentityScope(
      scope,
      async (client) => {
        const result = await client.query<AnswerRow>(
          `SELECT ${ANSWER_COLUMNS}
             FROM agent_platform.answer_publications
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND run_id = $1`,
          [runId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toAnswer(row)
      },
      { readOnly: true },
    )
  }

  async findByAnswer(answerId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    const scope = scopeOf(ctx)
    return this.#database.withIdentityScope(
      scope,
      async (client) => {
        const result = await client.query<AnswerRow>(
          `SELECT ${ANSWER_COLUMNS}
             FROM agent_platform.answer_publications
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND answer_id = $1`,
          [answerId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toAnswer(row)
      },
      { readOnly: true },
    )
  }
}
