import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresIndustryValidationReportStore,
  PostgresJobStore,
  PostgresSyntheticExampleSetStore,
} from '@ontology/adapter-control-postgres'
import {
  IndustryValidationService,
  IndustryWorkspaceService,
  RuleActionCandidateService,
  SyntheticExampleService,
} from '@ontology/application'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator } from '@ontology/semantic-engine'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type {
  ActionCapabilityBindingInput,
  DefinitionCompatibilityReport,
  DefinitionValidationReport,
  DefinitionPublicationValidationPort,
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
let exampleStore: PostgresSyntheticExampleSetStore
let ruleActionService: RuleActionCandidateService

/** Minimal real-PostgreSQL RuleActionCandidateStore for this suite (mirrors migration 064). */
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
      const result = await client.query(`SELECT * FROM agent_platform.asset_rule_action_candidates WHERE candidate_id = $1`, [candidateId])
      const row = result.rows[0]
      return row === undefined ? undefined : rowToCandidate(row)
    })
  }

  async list(scopeRef: ScopeRef, workspaceId: Uuid, query: RuleActionCandidateQuery, ctx: ToolContext): Promise<RuleActionCandidateVersion[]> {
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

  async transition(scopeRef: ScopeRef, candidateId: Uuid, transition: RuleActionCandidateTransition, ctx: ToolContext): Promise<RuleActionCandidateVersion> {
    return this.#withScope(scopeRef, ctx, async (client) => {
      const result = await client.query(
        `UPDATE agent_platform.asset_rule_action_candidates SET lifecycle = $1, enabled_at = $2 WHERE candidate_id = $3 RETURNING *`,
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
    const result = await client.query(`SELECT * FROM agent_platform.asset_rule_action_candidates WHERE idempotency_key = $1`, [key])
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

class StubDefinitionValidation {
  async validateForPublication(input: Parameters<DefinitionPublicationValidationPort['validateForPublication']>[0], _ctx: ToolContext): Promise<DefinitionValidationReport> {
    void _ctx
    const compatibility: DefinitionCompatibilityReport = {
      workspaceId: input.workspaceId,
      revision: '1',
      additions: [],
      changes: [],
      breakingChanges: [],
      requiresRevisionStrategy: false,
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
    }
    return {
      workspaceId: input.workspaceId,
      revision: '1',
      checkedCandidateIds: [],
      blockers: [],
      warnings: [],
      nonExecutableRules: [],
      compatibility,
      publishable: true,
    }
  }
}

function authenticator(request: { headers: Record<string, string | string[] | undefined> }): AuthenticatedRequest | undefined {
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

function versionRef(id: string, digest = DIGEST): { id: string; version: string; digest: string } {
  return { id, version: '1.0.0', digest }
}

function editorContext(): ToolContext {
  return toolContext(scope.tenantId, scope.spaceId, ['profile-editor'], 'editor-1')
}

function otherContext(): ToolContext {
  return toolContext(otherScope.tenantId, otherScope.spaceId, ['profile-editor'], 'editor-1')
}

function bindingContext(): ActionCapabilityBindingInput {
  return {
    registry: {
      namespace: 'home-energy',
      registryVersion: '1.0.0',
      registryDigest: DIGEST,
      operations: [
        {
          operationRef: { id: 'home-energy.plan', version: '1' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          inputSchemaDigest: IN_SCHEMA,
          outputSchemaDigest: OUT_SCHEMA,
          handlerRef: { id: 'extension-home-energy', version: '0.1.0', digest: DIGEST },
          handlerDigest: DIGEST,
          readOnly: true,
          requiredCapabilities: ['home-energy.planning'],
          limits: { maxRows: 100, maxBytes: 65536, maxDurationMs: 2000 },
          dataMode: 'simulation' as const,
        },
      ],
    },
    authorizedOperations: [{ id: 'home-energy.plan', version: '1' }],
    availableCapabilities: ['home-energy.planning'],
    recordedAt: '2026-09-29T00:00:00Z',
  }
}

async function createWorkspace(): Promise<string> {
  const response = await post('/api/v1/industry-workspaces', {
    body: {
      namespace: 'synthetic-integration',
      displayName: 'Synthetic integration',
      boundary: { goals: [], included: [], excluded: [], applicability: {} },
      documentSetRef: resourceRef(),
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId
}

const POWER_RANGE: RuleExpressionNode = { op: 'range', attributeId: 'power', min: 10, unitCode: 'kW', spans: [] }

function syntheticCases() {
  return [
    { caseId: 'case-missing', caseKind: 'missing_parameter' as const, objectTypeRef: 'device', fields: [] },
    {
      caseId: 'case-wrong-unit',
      caseKind: 'wrong_unit' as const,
      objectTypeRef: 'device',
      fields: [{ fieldId: 'power', value: 5, unitCode: 'kWh' }],
    },
    {
      caseId: 'case-contradiction',
      caseKind: 'contradiction' as const,
      objectTypeRef: 'device',
      fields: [
        { fieldId: 'power', value: 5, unitCode: 'kW' },
        { fieldId: 'power', value: 20, unitCode: 'kW' },
      ],
    },
    {
      caseId: 'case-same-name',
      caseKind: 'same_name_different_meaning' as const,
      objectTypeRef: 'device',
      displayName: 'Meter',
      alternateObjectTypeRef: 'sensor',
      fields: [{ fieldId: 'power', value: 5, unitCode: 'kW' }],
    },
    {
      caseId: 'case-missing-capability',
      caseKind: 'missing_capability' as const,
      objectTypeRef: 'device',
      fields: [{ fieldId: 'power', value: 20, unitCode: 'kW' }],
    },
  ]
}

function syntheticExpectations() {
  const base = {
    origin: 'authored_oracle' as const,
    reason: 'independent oracle',
    confirmedBy: 'expert-1',
    confirmedAt: '2026-09-29T00:00:00Z',
  }
  return [
    { ...base, expectationId: 'e-missing', caseId: 'case-missing', kind: 'rule' as const, ruleId: 'rule.power_ok', expected: 'unknown' as const },
    { ...base, expectationId: 'e-wrong-unit', caseId: 'case-wrong-unit', kind: 'rule' as const, ruleId: 'rule.power_ok', expected: 'unknown' as const },
    { ...base, expectationId: 'e-contradiction', caseId: 'case-contradiction', kind: 'rule' as const, ruleId: 'rule.power_ok', expected: 'conflict' as const },
    { ...base, expectationId: 'e-same-name', caseId: 'case-same-name', kind: 'rule' as const, ruleId: 'rule.power_ok', expected: 'false' as const },
    { ...base, expectationId: 'e-action', caseId: 'case-missing-capability', kind: 'action' as const, actionId: 'action.plan_charge', expected: 'executable' as const },
  ]
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'synthetic')
  otherScope = await createJobScope(harness.adminClient, 'synthetic-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  pool = new Pool({ connectionString: harness.appUrl, max: 4 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: new PostgresJobStore(database) })
  const ruleActionStore = new PostgresRuleActionCandidateStore(pool)
  ruleActionService = new RuleActionCandidateService({
    workspaces: workspaceStore,
    candidates: ruleActionStore,
    support: new FiniteGrammarRuleSupportValidator(),
  })
  exampleStore = new PostgresSyntheticExampleSetStore(database)
  const reportStore = new PostgresIndustryValidationReportStore(database)
  const exampleService = new SyntheticExampleService({ workspaces: workspaceStore, sets: exampleStore })
  const validationService = new IndustryValidationService({
    workspaces: workspaceStore,
    exampleSets: exampleStore,
    reports: reportStore,
    definitions: new StubDefinitionValidation(),
    ruleActions: ruleActionStore,
    support: new FiniteGrammarRuleSupportValidator(),
    evaluator: new FiniteGrammarSyntheticEvaluator(),
  })
  app = createApiServer({
    authenticate: authenticator,
    industryWorkspaces: { service: workspaceService },
    ruleActionCandidates: { service: ruleActionService, bindingContext: () => bindingContext() },
    syntheticValidation: { exampleService, validationService, bindingContext: () => bindingContext() },
  })
  await app.ready()
}, 300_000)

afterAll(async () => {
  await app?.close()
  await pool?.end().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('synthetic validation (real PostgreSQL)', () => {
  it('applies migration 065 with RLS on both sandbox tables', async () => {
    const tables = await harness.adminClient.query<{ table_name: string; relrowsecurity: boolean }>(
      `SELECT c.relname AS table_name, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relname IN ('synthetic_example_sets', 'industry_validation_reports')`,
    )
    expect(tables.rows).toHaveLength(2)
    for (const row of tables.rows) expect(row.relrowsecurity).toBe(true)
  })

  it('creates an isolated synthetic set, validates it, gates publication and refuses promotion', async () => {
    const workspaceId = await createWorkspace()
    await ruleActionService.saveRuleCandidate(
      workspaceId,
      {
        displayName: 'Power rule',
        businessMeaning: 'power must be at least 10 kW',
        suggestedReason: 'derived from source',
        ruleId: 'rule.power_ok',
        applicability: { objectId: 'device' },
        condition: POWER_RANGE,
        exceptions: [],
        ruleDependencies: [],
        sourceRefs: [resourceRef()],
        expectedRevision: '1',
        idempotencyKey: `rule-${randomUUID()}`,
      },
      'editor-1',
      editorContext(),
    )
    await ruleActionService.saveActionCandidate(
      workspaceId,
      {
        declaration: {
          actionId: 'action.plan_charge',
          displayName: 'Plan charge',
          businessMeaning: 'plan a charge schedule',
          suggestedReason: 'from source',
          inputSchemaRef: versionRef('home-energy.plan.input', IN_SCHEMA),
          outputSchemaRef: versionRef('home-energy.plan.output', OUT_SCHEMA),
          preconditions: [],
          requiredCapabilities: [{ name: 'home-energy.planning', versionRange: { min: '1.0.0' } }],
          permissions: [],
          readOnly: true,
          sideEffect: 'read_only',
          evidenceRequirements: [],
          suggestedOperationRef: { id: 'home-energy.plan', version: '1' },
        },
        sourceRefs: [resourceRef()],
        expectedRevision: '1',
        idempotencyKey: `action-${randomUUID()}`,
        bindingContext: bindingContext(),
      },
      'editor-1',
      editorContext(),
    )

    const generate = await post(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, {
      ifMatch: '1',
      body: {
        caseKinds: ['missing_parameter', 'same_name_different_meaning', 'contradiction', 'wrong_unit', 'missing_capability'],
        cases: syntheticCases(),
        expectations: syntheticExpectations(),
      },
    })
    expect(generate.statusCode).toBe(201)
    const generated = generate.json() as { data: { exampleSet: { exampleSetId: string; dataMode: string; sourceKind: string; isolationLabel: string } } }
    const exampleSetId = generated.data.exampleSet.exampleSetId
    expect(generated.data.exampleSet.dataMode).toBe('synthetic')
    expect(generated.data.exampleSet.sourceKind).toBe('synthetic')
    expect(generated.data.exampleSet.isolationLabel).toBe('synthetic test')

    const strategy = { kind: 'new_version', reason: 'expert chose a new immutable version' }
    const validate = await post(`/api/v1/industry-workspaces/${workspaceId}/validations`, {
      ifMatch: '1',
      body: { exampleSetId, strategy },
    })
    expect(validate.statusCode).toBe(201)
    const body = validate.json() as {
      data: { validation: { validationId: string; publishable: boolean; gate: string; semanticPublished: { passed: boolean; blockers: unknown[] }; deploymentExecutable: { passed: boolean; blockers: unknown[] }; realFactsWritten: boolean; businessApproval: string; issues: unknown[] } }
    }
    expect(body.data.validation.publishable).toBe(true)
    expect((validate.json() as { data: { validation: { strategy: unknown; definition: { compatibility: { strategy: unknown } } } } }).data.validation.strategy).toEqual(strategy)
    expect((validate.json() as { data: { validation: { definition: { compatibility: { strategy: unknown } } } } }).data.validation.definition.compatibility.strategy).toEqual(strategy)
    expect(body.data.validation.semanticPublished.passed).toBe(true)
    expect(body.data.validation.deploymentExecutable.passed).toBe(true)
    expect(body.data.validation.realFactsWritten).toBe(false)
    expect(body.data.validation.businessApproval).toBe('none')
    const validationId = body.data.validation.validationId

    const gate = await post(`/api/v1/industry-workspaces/${workspaceId}/validations/${validationId}/publication-gate`, { body: {} })
    expect(gate.statusCode).toBe(200)
    expect((gate.json() as { data: { publishable: boolean } }).data.publishable).toBe(true)

    const promotion = await post(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets/${exampleSetId}/promotions`, {
      body: { targetDataMode: 'observed' },
    })
    expect(promotion.statusCode).toBe(409)
    expect((promotion.json() as { error: { code: string } }).error.code).toBe('SYNTHETIC_NOT_PUBLISHABLE')

    // A synthetic set is only visible in the scope that created it.
    const otherRead = await get(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets/${exampleSetId}`, {
      scope: 'other',
    })
    expect(otherRead.statusCode).toBe(404)
    const isolated = await exampleStore.get({ tenantId: otherScope.tenantId, spaceId: otherScope.spaceId }, workspaceId, exampleSetId, otherContext())
    expect(isolated).toBeUndefined()

    // The row keeps the hard-coded synthetic markers and never becomes a project fact.
    const stored = await harness.adminClient.query<{ source_kind: string; data_mode: string; isolation_label: string }>(
      `SELECT source_kind, data_mode, isolation_label FROM agent_platform.synthetic_example_sets WHERE example_set_id = $1`,
      [exampleSetId],
    )
    expect(stored.rows[0]).toEqual({ source_kind: 'synthetic', data_mode: 'synthetic', isolation_label: 'synthetic test' })
  })

  it.each([null, { kind: 'unknown', reason: 'bad' }, { kind: 'new_version', reason: '' }, { kind: 'new_version', reason: ' ' }, { kind: 'retire_previous', reason: 'retire', supersedesRef: { id: 'old' } }])('rejects a malformed revision strategy at the validation route: %j', async (strategy) => {
    const response = await post(`/api/v1/industry-workspaces/${randomUUID()}/validations`, { ifMatch: '1', body: { exampleSetId: randomUUID(), strategy } })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { message: string } }).error.message).toContain('strategy')
  })

  it('blocks an invalid expectation and reports the failure through the gate', async () => {
    const workspaceId = await createWorkspace()
    await ruleActionService.saveRuleCandidate(
      workspaceId,
      {
        displayName: 'Power rule',
        businessMeaning: 'b',
        suggestedReason: 's',
        ruleId: 'rule.power_ok',
        applicability: { objectId: 'device' },
        condition: POWER_RANGE,
        exceptions: [],
        ruleDependencies: [],
        sourceRefs: [resourceRef()],
        expectedRevision: '1',
        idempotencyKey: `rule-${randomUUID()}`,
      },
      'editor-1',
      editorContext(),
    )
    const expectations = syntheticExpectations()
      .filter((expectation) => expectation.kind === 'rule')
      .map((expectation) =>
        expectation.kind === 'rule' && expectation.caseId === 'case-same-name'
          ? { ...expectation, expected: 'true' as const }
          : expectation,
      )
    const generate = await post(`/api/v1/industry-workspaces/${workspaceId}/synthetic-example-sets`, {
      ifMatch: '1',
      body: {
        caseKinds: ['missing_parameter', 'same_name_different_meaning', 'contradiction', 'wrong_unit', 'missing_capability'],
        cases: syntheticCases(),
        expectations,
      },
    })
    expect(generate.statusCode).toBe(201)
    const exampleSetId = (generate.json() as { data: { exampleSet: { exampleSetId: string } } }).data.exampleSet.exampleSetId

    const validate = await post(`/api/v1/industry-workspaces/${workspaceId}/validations`, { ifMatch: '1', body: { exampleSetId } })
    expect(validate.statusCode).toBe(201)
    const report = validate.json() as { data: { validation: { validationId: string; publishable: boolean; gate: string } } }
    expect(report.data.validation.publishable).toBe(false)
    expect(report.data.validation.gate).toBe('blocked_execution')

    const gate = await post(
      `/api/v1/industry-workspaces/${workspaceId}/validations/${report.data.validation.validationId}/publication-gate`,
      { body: {} },
    )
    expect(gate.statusCode).toBe(409)
  })
})
