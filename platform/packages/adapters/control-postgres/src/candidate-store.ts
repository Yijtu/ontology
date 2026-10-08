import { CandidateStoreError, assertProjectFactInputShape, assertRuleDependencyShape, isToolContext } from '@ontology/contracts'
import type {
  CandidateInsertResult,
  CandidateIssue,
  CandidateQuery,
  CandidateRecord,
  CandidateSourceSpan,
  CandidateState,
  CandidateStateCounts,
  CandidateStateTransition,
  CandidateStore,
  EntityCandidate,
  ExtractionInputVersion,
  GenerationUsage,
  RelationCandidate,
  RuleCandidate,
  RuleUnhandledCandidate,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface CandidateRow extends QueryResultRow {
  candidate_id: string
  job_id: string
  kind: string
  state: CandidateState
  deterministic: boolean
  idempotency_key: string
  definition_ref: VersionRef
  input_version: ExtractionInputVersion
  parse_id: string
  source_spans: CandidateSourceSpan[]
  payload: Record<string, unknown>
  issues: CandidateIssue[]
  usage: GenerationUsage | null
  recorded_at: Date
  transitioned_at: Date | null
}

const CANDIDATE_COLUMNS = `candidate_id, job_id, kind, state, deterministic, idempotency_key,
  definition_ref, input_version, parse_id, source_spans, payload, issues, usage, recorded_at,
  transitioned_at`

function toCandidateRecord(row: CandidateRow): CandidateRecord {
  const common = {
    candidateId: row.candidate_id,
    jobId: row.job_id,
    sourceSpans: row.source_spans,
    deterministic: row.deterministic,
    state: row.state,
    issues: row.issues,
    inputVersion: row.input_version,
    ...(row.usage === null ? {} : { usage: row.usage }),
    idempotencyKey: row.idempotency_key,
    recordedAt: row.recorded_at.toISOString(),
  }
  if (row.kind === 'entity') {
    const objectId = row.payload['objectId']
    const identityScopeId = row.payload['identityScopeId']
    const nativeId = row.payload['nativeId']
    const attributes = row.payload['attributes']
    const entity: EntityCandidate = {
      ...common,
      kind: 'entity',
      objectId: typeof objectId === 'string' ? objectId : '',
      attributes: Array.isArray(attributes) ? (attributes as EntityCandidate['attributes']) : [],
      ...(typeof identityScopeId === 'string' ? { identityScopeId } : {}),
      ...(typeof nativeId === 'string' ? { nativeId } : {}),
    }
    return entity
  }
  const relation: RelationCandidate = {
    ...common,
    kind: 'relation',
    relationId: typeof row.payload['relationId'] === 'string' ? row.payload['relationId'] : '',
    from: row.payload['from'] as RelationCandidate['from'],
    to: row.payload['to'] as RelationCandidate['to'],
  }
  if (row.kind === 'relation') return relation

  if (row.kind === 'rule') {
    const dependencyRefs = row.payload['dependencyRefs'] ?? []
    assertRuleDependencyShape(row.payload['ruleDependencies'] ?? [], dependencyRefs)
    const rule: RuleCandidate = {
      ...common,
      kind: 'rule',
      ruleId: typeof row.payload['ruleId'] === 'string' ? row.payload['ruleId'] : '',
      objectId: typeof row.payload['objectId'] === 'string' ? row.payload['objectId'] : '',
      severity: row.payload['severity'] === 'hard' ? 'hard' : 'soft',
      impact: row.payload['impact'] === 'high' ? 'high' : 'low',
      reviewRequirement: row.payload['reviewRequirement'] === 'required' ? 'required' : 'policy_eligible',
      expression: row.payload['expression'] as RuleCandidate['expression'],
      exceptions: Array.isArray(row.payload['exceptions'])
        ? (row.payload['exceptions'] as RuleCandidate['exceptions'])
        : [],
      conflicts: Array.isArray(row.payload['conflicts'])
        ? (row.payload['conflicts'] as RuleCandidate['conflicts'])
        : [],
      ...(row.payload['conclusion'] === undefined ? {} : { conclusion: row.payload['conclusion'] }),
      ...(row.payload['ruleDependencies'] === undefined ? {} : { ruleDependencies: row.payload['ruleDependencies'] as readonly string[] }),
      ...(row.payload['dependencyRefs'] === undefined ? {} : { dependencyRefs }),
      ...(typeof row.payload['projectId'] !== 'string' ? {} : { projectId: row.payload['projectId'] }),
    }
    return rule
  }

  const unhandled: RuleUnhandledCandidate = {
    ...common,
    kind: 'rule_unhandled',
    ...(typeof row.payload['ruleId'] === 'string' ? { ruleId: row.payload['ruleId'] } : {}),
    reason: row.payload['reason'] as RuleUnhandledCandidate['reason'],
    detail: typeof row.payload['detail'] === 'string' ? row.payload['detail'] : '',
    rawExpression: typeof row.payload['rawExpression'] === 'string' ? row.payload['rawExpression'] : '',
  }
  return unhandled
}

function payloadOf(candidate: CandidateRecord): Record<string, unknown> {
  if (candidate.kind === 'entity') {
    return {
      objectId: candidate.objectId,
      ...(candidate.identityScopeId === undefined ? {} : { identityScopeId: candidate.identityScopeId }),
      ...(candidate.nativeId === undefined ? {} : { nativeId: candidate.nativeId }),
      attributes: candidate.attributes,
    }
  }
  if (candidate.kind === 'relation') {
    return { relationId: candidate.relationId, from: candidate.from, to: candidate.to }
  }
  if (candidate.kind === 'rule') {
    assertRuleDependencyShape(candidate.ruleDependencies ?? [], candidate.dependencyRefs ?? [])
    return {
      ruleId: candidate.ruleId,
      objectId: candidate.objectId,
      severity: candidate.severity,
      impact: candidate.impact,
      reviewRequirement: candidate.reviewRequirement,
      expression: candidate.expression,
      exceptions: candidate.exceptions,
      conflicts: candidate.conflicts,
      ...(candidate.conclusion === undefined ? {} : { conclusion: candidate.conclusion }),
      ...(candidate.ruleDependencies === undefined ? {} : { ruleDependencies: candidate.ruleDependencies }),
      ...(candidate.dependencyRefs === undefined ? {} : { dependencyRefs: candidate.dependencyRefs }),
      ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
    }
  }
  return {
    ...(candidate.ruleId === undefined ? {} : { ruleId: candidate.ruleId }),
    reason: candidate.reason,
    detail: candidate.detail,
    rawExpression: candidate.rawExpression,
  }
}

/**
 * PostgreSQL-backed candidate store (migration 022). It connects as the non-owner
 * application role, so RLS is a real second line of defence behind the explicit
 * (tenant_id, space_id) predicates, and insertion is idempotent on `idempotency_key` so a
 * stage-precise retry never duplicates a candidate.
 */
export class PostgresCandidateStore implements CandidateStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async insertCandidates(
    scopeRef: ScopeRef,
    candidates: readonly CandidateRecord[],
    ctx: ToolContext,
  ): Promise<CandidateInsertResult> {
    for (const candidate of candidates) {
      if (candidate.inputVersion.projectFact !== undefined) assertProjectFactInputShape(candidate.inputVersion.projectFact)
    }
    return this.#withScope(scopeRef, ctx, async (query) => {
      const candidateIds: Uuid[] = []
      let inserted = 0
      let existing = 0
      for (const candidate of candidates) {
        const result = await query.query<{ candidate_id: string }>(
          `INSERT INTO agent_platform.extraction_candidates (
             tenant_id, space_id, candidate_id, job_id, kind, state, deterministic,
             idempotency_key, definition_ref, input_version, parse_id, source_spans, payload,
             issues, usage, recorded_at)
           VALUES (
             current_setting('app.tenant_id')::uuid,
             current_setting('app.space_id')::uuid,
             $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb,
             $12::jsonb, $13::jsonb, $14::timestamptz)
           ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING
           RETURNING candidate_id`,
          [
            candidate.candidateId,
            candidate.jobId,
            candidate.kind,
            candidate.state,
            candidate.deterministic,
            candidate.idempotencyKey,
            JSON.stringify(candidate.inputVersion.definitionRef),
            JSON.stringify(candidate.inputVersion),
            candidate.inputVersion.parseId,
            JSON.stringify(candidate.sourceSpans),
            JSON.stringify(payloadOf(candidate)),
            JSON.stringify(candidate.issues),
            candidate.usage === undefined ? null : JSON.stringify(candidate.usage),
            candidate.recordedAt,
          ],
        )
        const insertedRow = result.rows[0]
        if (insertedRow !== undefined) {
          inserted += 1
          candidateIds.push(insertedRow.candidate_id)
          continue
        }
        const prior = await query.query<{ candidate_id: string }>(
          `SELECT candidate_id FROM agent_platform.extraction_candidates
            WHERE tenant_id = current_setting('app.tenant_id')::uuid
              AND space_id = current_setting('app.space_id')::uuid
              AND idempotency_key = $1`,
          [candidate.idempotencyKey],
        )
        const priorRow = prior.rows[0]
        if (priorRow === undefined) {
          throw new CandidateStoreError(
            'CANDIDATE_STORE_FAILED',
            `candidate ${candidate.candidateId} conflicted without an existing row`,
          )
        }
        existing += 1
        candidateIds.push(priorRow.candidate_id)
      }
      return { inserted, existing, candidateIds }
    })
  }

  async getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateRecord | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM agent_platform.extraction_candidates
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $1`,
        [candidateId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : toCandidateRecord(row)
    })
  }

  async listCandidates(
    scopeRef: ScopeRef,
    query: CandidateQuery,
    ctx: ToolContext,
  ): Promise<CandidateRecord[]> {
    return this.#withScope(scopeRef, ctx, async (scoped) => {
      const clauses = [
        `tenant_id = current_setting('app.tenant_id')::uuid`,
        `space_id = current_setting('app.space_id')::uuid`,
      ]
      const values: unknown[] = []
      if (query.jobId !== undefined) {
        values.push(query.jobId)
        clauses.push(`job_id = $${String(values.length)}`)
      }
      if (query.state !== undefined) {
        values.push(query.state)
        clauses.push(`state = $${String(values.length)}`)
      }
      if (query.kind !== undefined) {
        values.push(query.kind)
        clauses.push(`kind = $${String(values.length)}`)
      }
      values.push(query.limit ?? 1_000)
      const result = await scoped.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM agent_platform.extraction_candidates
          WHERE ${clauses.join(' AND ')}
          ORDER BY recorded_at, candidate_id
          LIMIT $${String(values.length)}`,
        values,
      )
      return result.rows.map(toCandidateRecord)
    })
  }

  async transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: CandidateStateTransition,
    ctx: ToolContext,
  ): Promise<CandidateRecord> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<CandidateRow>(
        `UPDATE agent_platform.extraction_candidates
            SET state = $1, issues = $2::jsonb, transitioned_at = $3::timestamptz
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND candidate_id = $4
          RETURNING ${CANDIDATE_COLUMNS}`,
        [transition.state, JSON.stringify(transition.issues), transition.transitionedAt, candidateId],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new CandidateStoreError(
          'CANDIDATE_NOT_FOUND',
          `candidate ${candidateId} is not visible in this scope`,
        )
      }
      return toCandidateRecord(row)
    })
  }

  async countCandidates(
    scopeRef: ScopeRef,
    jobId: Uuid,
    ctx: ToolContext,
  ): Promise<CandidateStateCounts> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<{ state: CandidateState; count: string }>(
        `SELECT state, count(*)::text AS count FROM agent_platform.extraction_candidates
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND job_id = $1
          GROUP BY state`,
        [jobId],
      )
      const byState = new Map<CandidateState, number>()
      let total = 0
      for (const row of result.rows) {
        const count = Number(row.count)
        byState.set(row.state, count)
        total += count
      }
      const pendingReview = byState.get('pending_review') ?? 0
      const failed = byState.get('failed') ?? 0
      const rejected = byState.get('rejected') ?? 0
      return {
        total,
        produced: byState.get('produced') ?? 0,
        pendingReview,
        failed,
        rejected,
      }
    })
  }

  async #withScope<T>(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    run: (query: ScopedQuery) => Promise<T>,
  ): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new CandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (
      ctx.allowedResources.tenantId !== tenantId ||
      scopeRef.tenantId !== tenantId ||
      scopeRef.spaceId !== spaceId
    ) {
      throw new CandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    return this.#database.withIdentityScope({ tenantId, spaceId }, async (client) =>
      run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      }),
    )
  }
}
