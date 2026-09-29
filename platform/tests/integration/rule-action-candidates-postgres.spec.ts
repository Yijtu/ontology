import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  IndustryWorkspaceService,
  RuleActionCandidateService,
  parseRuleActionCandidateOutput,
} from '@ontology/application'
import type { IngestRuleActionOutputView } from '@ontology/application'
import { FiniteGrammarRuleSupportValidator } from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  ResourceRef,
  RuleActionCandidateQuery,
  RuleActionCandidateStore,
  RuleActionCandidateTransition,
  RuleActionCandidateVersion,
  RuleExpressionNode,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { RuleActionCandidateStoreError, isToolContext } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { toolContext } from '../unit/component-registry-fixtures'

const DIGEST = `sha256:${'d'.repeat(64)}`
const IN_SCHEMA = `sha256:${'a'.repeat(64)}`
const OUT_SCHEMA = `sha256:${'b'.repeat(64)}`

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let pool: Pool
let app: ReturnType<typeof createApiServer>
let service: RuleActionCandidateService

/**
 * A minimal real-PostgreSQL `RuleActionCandidateStore` for the integration suite. It mirrors
 * the in-memory reference store and runs every statement through RLS as the non-owner
 * `ontology_app` role, so the migration, the scope predicate and the lifecycle checks are
 * verified against the real database instead of a fake.
 */
class PostgresRuleActionCandidateStore implements RuleActionCandidateStore {
  readonly #pool: Pool

  constructor(pool: Pool) {
    this.#pool = pool
  }

  async #withScope<T>(scopeRef: ScopeRef, ctx: ToolContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!isToolContext(ctx)) {
      throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (ctx.principal.tenantId !== scopeRef.tenantId || ctx.allowedResources.spaceId !== scopeRef.spaceId) {
      throw new RuleActionCandidateStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', scopeRef.tenantId])
      await client.query('SELECT set_config($1, $2, true)', ['app.space_id', scopeRef.spaceId])
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async insert(scopeRef: ScopeRef, candidate: RuleActionCandidateVersion, ctx: ToolContext): Promise<RuleActionCandidateVersion> {
    return this.#withScope(scopeRef, ctx, async (client) => {
      const inserted = await client.query(
        `INSERT INTO agent_platform.asset_rule_action_candidates
           (tenant_id, space_id, candidate_id, workspace_id, logical_id, domain, kind, display_name,
            business_meaning, suggested_reason, payload, source_refs, source_spans, lifecycle,
            replaces_candidate_id, content_digest, idempotency_key, actor, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (tenant_id, space_id, idempotency_key) DO NOTHING`,
        [
          scopeRef.tenantId,
          scopeRef.spaceId,
          candidate.candidateId,
          candidate.workspaceId,
          candidate.logicalId,
          candidate.domain,
          candidate.kind,
          candidate.displayName,
          candidate.businessMeaning,
          candidate.suggestedReason,
          JSON.stringify(candidate.payload),
          JSON.stringify(candidate.sourceRefs),
          JSON.stringify(candidate.sourceSpans),
          candidate.lifecycle,
          candidate.replacesCandidateId ?? null,
          candidate.contentDigest,
          candidate.idempotencyKey,
          candidate.actor,
          candidate.recordedAt,
        ],
      )
      if (inserted.rowCount === 0) {
        const stored = await this.#byIdempotency(client, candidate.idempotencyKey)
        if (stored === undefined) {
          throw new RuleActionCandidateStoreError('STORE_FAILED', 'the idempotent candidate row is missing')
        }
        if (stored.contentDigest !== candidate.contentDigest) {
          throw new RuleActionCandidateStoreError('IDEMPOTENCY_CONFLICT', 'the idempotency key was reused with different content')
        }
        return stored
      }
      return candidate
    })
  }

  async get(scopeRef: ScopeRef, candidateId: Uuid, ctx: ToolContext): Promise<RuleActionCandidateVersion | undefined> {
    return this.#withScope(scopeRef, ctx, async (client) => {
      const result = await client.query(
        `SELECT * FROM agent_platform.asset_rule_action_candidates WHERE candidate_id = $1`,
        [candidateId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : rowToCandidate(row)
    })
  }

  async list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: RuleActionCandidateQuery,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion[]> {
    return this.#withScope(scopeRef, ctx, async (client) => {
      const result = await client.query(
        `SELECT * FROM agent_platform.asset_rule_action_candidates
          WHERE workspace_id = $1
            AND ($2::text IS NULL OR kind = $2)
            AND ($3::text IS NULL OR lifecycle = $3)
          ORDER BY recorded_at ASC, candidate_id ASC
          LIMIT $4`,
        [workspaceId, query.kind ?? null, query.lifecycle ?? null, query.limit ?? 100],
      )
      return result.rows.map(rowToCandidate)
    })
  }

  async transition(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: RuleActionCandidateTransition,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion> {
    return this.#withScope(scopeRef, ctx, async (client) => {
      const result = await client.query(
        `UPDATE agent_platform.asset_rule_action_candidates
            SET lifecycle = $1, enabled_at = $2
          WHERE candidate_id = $3
          RETURNING *`,
        [transition.lifecycle, transition.enabledAt ?? null, candidateId],
      )
      const row = result.rows[0]
      if (row === undefined) {
        throw new RuleActionCandidateStoreError('CANDIDATE_NOT_FOUND', `candidate ${candidateId} is not visible in this scope`)
      }
      return rowToCandidate(row)
    })
  }

  async #byIdempotency(client: PoolClient, key: string): Promise<RuleActionCandidateVersion | undefined> {
    const result = await client.query(
      `SELECT * FROM agent_platform.asset_rule_action_candidates WHERE idempotency_key = $1`,
      [key],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : rowToCandidate(row)
  }
}

interface CandidateRow {
  readonly candidate_id: string
  readonly workspace_id: string
  readonly logical_id: string
  readonly kind: 'rule' | 'action'
  readonly display_name: string
  readonly business_meaning: string
  readonly suggested_reason: string
  readonly payload: RuleActionCandidateVersion['payload']
  readonly source_refs: readonly ResourceRef[]
  readonly source_spans: RuleActionCandidateVersion['sourceSpans']
  readonly lifecycle: RuleActionCandidateVersion['lifecycle']
  readonly enabled_at: Date | null
  readonly replaces_candidate_id: string | null
  readonly generation_call_ref: ResourceRef | null
  readonly content_digest: string
  readonly idempotency_key: string
  readonly actor: string
  readonly recorded_at: Date
}

function rowToCandidate(row: CandidateRow): RuleActionCandidateVersion {
  return {
    candidateId: row.candidate_id,
    workspaceId: row.workspace_id,
    logicalId: row.logical_id,
    domain: 'definition',
    kind: row.kind,
    displayName: row.display_name,
    businessMeaning: row.business_meaning,
    suggestedReason: row.suggested_reason,
    payload: row.payload,
    sourceRefs: row.source_refs,
    sourceSpans: row.source_spans,
    lifecycle: row.lifecycle,
    ...(row.enabled_at === null ? {} : { enabledAt: row.enabled_at.toISOString() }),
    ...(row.replaces_candidate_id === null ? {} : { replacesCandidateId: row.replaces_candidate_id }),
    ...(row.generation_call_ref === null ? {} : { generationCallRef: row.generation_call_ref }),
    contentDigest: row.content_digest,
    idempotencyKey: row.idempotency_key,
    actor: row.actor,
    recordedAt: row.recorded_at.toISOString(),
  }
}

function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return {
    principal: { tenantId: chosen.tenantId, subjectId: subject, roles: ['profile-editor'], scopes: [], authEpoch: 1 },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly scope?: 'primary' | 'other'
  readonly ifMatch?: string
  readonly idempotencyKey?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-scope': options.scope ?? 'primary',
    'x-test-subject': 'editor-1',
    'idempotency-key': options.idempotencyKey ?? `idem-${randomUUID()}`,
  }
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  return headers
}

async function post(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'POST', url, headers: headersOf(options), ...(options.body === undefined ? {} : { payload: options.body }) })
}

async function get(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function editorContext(): ToolContext {
  return toolContext(scope.tenantId, scope.spaceId, ['profile-editor'], 'editor-1')
}

async function createWorkspace(): Promise<string> {
  const response = await post('/api/v1/industry-workspaces', {
    body: {
      namespace: 'rule-action-integration',
      displayName: 'Rule action integration',
      boundary: { goals: [], included: [], excluded: [], applicability: {} },
      documentSetRef: resourceRef(),
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

const SUPPORTED_CONDITION: RuleExpressionNode = { op: 'range', attributeId: 'operating_hours', min: 100, unitCode: 'h', spans: [] }
const UNSUPPORTED_CONDITION: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', spans: [] }

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'rule-action')
  otherScope = await createJobScope(harness.adminClient, 'rule-action-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  pool = new Pool({ connectionString: harness.appUrl, max: 4 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: new PostgresJobStore(database) })
  service = new RuleActionCandidateService({
    workspaces: workspaceStore,
    candidates: new PostgresRuleActionCandidateStore(pool),
    support: new FiniteGrammarRuleSupportValidator(),
  })
  app = createApiServer({
    authenticate: authenticator,
    industryWorkspaces: { service: workspaceService },
    ruleActionCandidates: { service },
  })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await pool?.end().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('rule/action candidates (real PostgreSQL)', () => {
  it('applies migration 064 with RLS and the lifecycle/kind constraints', async () => {
    const tables = await harness.adminClient.query<{ table_name: string; relrowsecurity: boolean }>(
      `SELECT c.relname AS table_name, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform' AND c.relname = 'asset_rule_action_candidates'`,
    )
    expect(tables.rows).toHaveLength(1)
    expect(tables.rows[0]?.relrowsecurity).toBe(true)

    const workspaceId = await createWorkspace()
    await expect(
      harness.adminClient.query(
        `INSERT INTO agent_platform.asset_rule_action_candidates
           (tenant_id, space_id, candidate_id, workspace_id, logical_id, kind, display_name, business_meaning,
            suggested_reason, payload, source_refs, source_spans, lifecycle, content_digest, idempotency_key, actor, recorded_at)
         VALUES ($1,$2,$3,$4,'x','rule','n','b','s','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'draft',$5,$6,'a',now())`,
        [scope.tenantId, scope.spaceId, randomUUID(), workspaceId, `sha256:${'e'.repeat(64)}`, `k-${randomUUID()}`],
      ),
    ).resolves.toBeDefined()

    // kind outside (rule|action) is rejected by the CHECK.
    await expect(
      harness.adminClient.query(
        `INSERT INTO agent_platform.asset_rule_action_candidates
           (tenant_id, space_id, candidate_id, workspace_id, logical_id, kind, display_name, business_meaning,
            suggested_reason, payload, source_refs, source_spans, lifecycle, content_digest, idempotency_key, actor, recorded_at)
         VALUES ($1,$2,$3,$4,'x','not_a_kind','n','b','s','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'draft',$5,$6,'a',now())`,
        [scope.tenantId, scope.spaceId, randomUUID(), workspaceId, `sha256:${'e'.repeat(64)}`, `k-${randomUUID()}`],
      ),
    ).rejects.toThrow()

    // enabled lifecycle without an enabled_at is rejected.
    await expect(
      harness.adminClient.query(
        `INSERT INTO agent_platform.asset_rule_action_candidates
           (tenant_id, space_id, candidate_id, workspace_id, logical_id, kind, display_name, business_meaning,
            suggested_reason, payload, source_refs, source_spans, lifecycle, content_digest, idempotency_key, actor, recorded_at)
         VALUES ($1,$2,$3,$4,'x','rule','n','b','s','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'enabled',$5,$6,'a',now())`,
        [scope.tenantId, scope.spaceId, randomUUID(), workspaceId, `sha256:${'e'.repeat(64)}`, `k-${randomUUID()}`],
      ),
    ).rejects.toThrow()
  })

  it('persists candidates, blocks unsupported rules and enables a supported one through the API', async () => {
    const workspaceId = await createWorkspace()
    const output = JSON.stringify({
      rules: [
        { ruleId: 'rule.supported', displayName: 'supported', businessMeaning: 'b', suggestedReason: 's', objectId: 'device', condition: SUPPORTED_CONDITION, exceptions: [], sourceIndex: 0 },
        { ruleId: 'rule.unsupported', displayName: 'unsupported', businessMeaning: 'b', suggestedReason: 's', objectId: 'device', condition: UNSUPPORTED_CONDITION, exceptions: [], sourceIndex: 0 },
      ],
    })
    const ingested = await post(`/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/ingest`, {
      ifMatch: '1',
      body: { rawOutput: output, sourceRefs: [resourceRef()] },
    })
    expect(ingested.statusCode).toBe(201)
    const view = (ingested.json() as { data: IngestRuleActionOutputView }).data
    expect(view.rules).toHaveLength(2)
    const supported = view.rules.find((rule) => rule.logicalId === 'rule.supported')
    const unsupported = view.rules.find((rule) => rule.logicalId === 'rule.unsupported')
    expect(supported).toBeDefined()
    expect(unsupported).toBeDefined()
    if (supported === undefined || unsupported === undefined) throw new Error('expected both rules')

    const blocked = await post(
      `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${unsupported.candidateId}/enable`,
      { ifMatch: '1', body: {} },
    )
    expect(blocked.statusCode).toBe(422)

    const afterBlocked = await service.getCandidate(unsupported.candidateId, editorContext())
    expect(afterBlocked?.lifecycle).toBe('draft')

    const enabled = await post(
      `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates/${supported.candidateId}/enable`,
      { ifMatch: '1', body: {} },
    )
    expect(enabled.statusCode).toBe(200)

    const listed = await get(
      `/api/v1/industry-workspaces/${workspaceId}/rule-action-candidates?kind=rule&lifecycle=enabled`,
    )
    expect(listed.statusCode).toBe(200)
    const candidates = (listed.json() as { data: { candidates: RuleActionCandidateVersion[] } }).data.candidates
    expect(candidates.map((candidate) => candidate.logicalId)).toContain('rule.supported')
  })

  it('keeps candidates isolated by scope through RLS', async () => {
    const workspaceId = await createWorkspace()
    const saved = await service.saveRuleCandidate(
      workspaceId,
      {
        displayName: 'isolated',
        businessMeaning: 'b',
        suggestedReason: 's',
        ruleId: 'rule.isolated',
        applicability: { objectId: 'device' },
        condition: SUPPORTED_CONDITION,
        exceptions: [],
        ruleDependencies: [],
        sourceRefs: [resourceRef()],
        expectedRevision: '1',
        idempotencyKey: `iso-${randomUUID()}`,
      },
      'editor-1',
      editorContext(),
    )
    expect(saved.lifecycle).toBe('draft')

    const otherContext = toolContext(otherScope.tenantId, otherScope.spaceId, ['profile-editor'], 'other-1')
    const fromOther = await service.getCandidate(saved.candidateId, otherContext)
    expect(fromOther).toBeUndefined()
  })

  it('rejects a model action that smuggles executable content', () => {
    const output = JSON.stringify({
      actions: [
        {
          actionId: 'action.evil',
          displayName: 'Evil',
          businessMeaning: 'b',
          suggestedReason: 's',
          inputSchemaRef: { id: 'x', version: '1.0.0', digest: IN_SCHEMA },
          outputSchemaRef: { id: 'y', version: '1.0.0', digest: OUT_SCHEMA },
          preconditions: [],
          requiredCapabilities: [],
          permissions: [],
          readOnly: true,
          sideEffect: 'read_only',
          evidenceRequirements: [],
          script: 'require("child_process")',
        },
      ],
    })
    expect(() => parseRuleActionCandidateOutput(output)).toThrow()
  })
})
