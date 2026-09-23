import { AnswerStoreError, isToolContext } from '@ontology/contracts'
import type {
  AnswerStorePort,
  PublicationKind,
  PublishedAnswer,
  RecordAnswerInput,
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
  body: { blocks: readonly unknown[]; claims: PublishedAnswer['claims'] } | null
  published_at: Date
}

interface RunStateRow extends QueryResultRow {
  state: RunState
  revision: string
}

const ANSWER_COLUMNS =
  'answer_id, run_id, draft_id, verification_id, content_hash, evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations, published_at, body'

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
    blocks: row.body?.blocks ?? [],
    claims: row.body?.claims ?? [],
    publishedAt: row.published_at.toISOString(),
  }
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

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async record(input: RecordAnswerInput, ctx: ToolContext): Promise<PublishedAnswer> {
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

      try {
        await client.query(
          `INSERT INTO agent_platform.answer_publications
             (tenant_id, space_id, run_id, answer_id, draft_id, verification_id, content_hash,
              evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations,
              published_at, body)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb, $11::timestamptz, $12::jsonb
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
            input.answer.publishedAt,
            JSON.stringify({ blocks: input.answer.blocks, claims: input.answer.claims }),
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
      return toAnswer(row)
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
}
