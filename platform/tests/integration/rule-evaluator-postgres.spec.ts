import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import {
  compilePublishedRuleInstances,
  projectPublishedAttributeFacts,
  RuleEvaluationError,
  RuleEvaluator,
  sha256DigestOf,
  supportRuleFromPublishedRule,
} from '@ontology/semantic-engine'
import type { RuleFact, SupportRule } from '@ontology/semantic-engine'
import type {
  NewOutboxMessage,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const SCHEMA_REF: VersionRef = { id: 'home-energy.core', version: '1.0.0', digest: DIGEST }
const DEVICE_SUBJECT = { subjectEntityId: 'device-1', objectId: 'device' } as const
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let store: PostgresSemanticPublicationStore
let jobId: Uuid

function sourceRefs(): ResourceRef[] {
  return [{ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' }]
}

function statementFor(
  attributeId: string,
  value: unknown,
  publicationId: Uuid,
  options: { readonly unitCode?: string; readonly validity?: { validFrom: string; validTo?: string } } = {},
): PublishedStatement {
  const statementId = randomUUID()
  const validity = options.validity ?? VALIDITY
  return {
    statementId,
    propositionKey: `${DEVICE_SUBJECT.subjectEntityId}.attributes`,
    kind: 'entity',
    objectId: DEVICE_SUBJECT.objectId,
    subjectEntityId: DEVICE_SUBJECT.subjectEntityId,
    predicate: DEVICE_SUBJECT.objectId,
    value: {
      attributes: [{
        attributeId,
        value,
        ...(options.unitCode === undefined ? {} : { unitCode: options.unitCode }),
      }],
    },
    validFrom: validity.validFrom,
    ...(validity.validTo === undefined ? {} : { validTo: validity.validTo }),
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    sourceRefs: sourceRefs(),
    publicationId,
    version: '1',
    status: 'active',
  }
}

function ruleVersionFor(
  ruleId: string,
  objectId: string,
  expression: PublishedRuleVersion['expression'],
  publicationId: Uuid,
): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId,
    version: '1',
    objectId,
    severity: 'soft',
    impact: 'low',
    expression,
    exceptions: [],
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

async function publishBundle(
  statements: readonly PublishedStatement[],
  ruleVersions: readonly PublishedRuleVersion[],
  key: string,
): Promise<void> {
  const publicationId = randomUUID()
  const withPublication = statements.map((statement) => ({ ...statement, publicationId }))
  const rules = ruleVersions.map((rule) => ({ ...rule, publicationId }))
  const expectedRevision = await store.latestPublicationRevision(scope.scopeRef, ctx)
  const outbox: NewOutboxMessage = {
    outboxId: randomUUID(),
    topic: 'semantic.publication.published',
    payload: { publicationId },
    idempotencyKey: `${key}:outbox`,
    availableAt: '2026-09-21T06:00:00Z',
    createdAt: '2026-09-21T06:00:00Z',
  }
  const input: PublishSemanticPublicationInput = {
    expectedRevision,
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: SCHEMA_REF,
      approvedCandidateRefs: [],
      statements: withPublication,
      ruleVersions: rules,
      outboxId: outbox.outboxId,
      publishedAt: '2026-09-21T06:00:00Z',
      actor: ctx.principal.subjectId,
    },
    idempotencyKey: key,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox,
    outboxJobId: jobId,
  }
  await store.publish(scope.scopeRef, input, ctx)
}

async function loadFacts(): Promise<RuleFact[]> {
  const statements = await store.listStatements(scope.scopeRef, { limit: 1_000 }, ctx)
  return [...projectPublishedAttributeFacts(statements, { schemaRef: SCHEMA_REF }).facts]
}

async function loadRules(facts: readonly RuleFact[]) {
  const versions = await store.listRuleVersions(scope.scopeRef, { limit: 1_000 }, ctx)
  return compilePublishedRuleInstances(versions, facts, {
    scopeRef: scope.scopeRef,
    definitionRef: SCHEMA_REF,
    subjects: [DEVICE_SUBJECT],
  })
}

function publishedRules(compilation: Awaited<ReturnType<typeof loadRules>>): SupportRule[] {
  return compilation.instances.map((instance) => instance.supportRule)
}

function applicabilityFor(
  result: ReturnType<RuleEvaluator['evaluate']>,
  ruleId: string,
) {
  const applicability = result.applicabilities.find((entry) =>
    entry.ruleId === ruleId && entry.subjectEntityId === DEVICE_SUBJECT.subjectEntityId,
  )
  if (applicability === undefined) throw new Error(`no applicability result for ${ruleId}`)
  return applicability
}

function attributeAssertionId(statementId: Uuid, attributeId: string): string {
  return `${statementId}#${encodeURIComponent(attributeId)}@1`
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'rule-evaluator')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  store = new PostgresSemanticPublicationStore(database)

  jobId = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', 'rule-evaluator', $4, '1.0.0', 'published',
       $5, $6, 1, '{}'::jsonb, now(), now(), 'rule-evaluator-test', now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      randomUUID(),
      `rule-evaluator-${jobId.slice(0, 8)}`,
      sha256DigestOf({ jobId }),
    ],
  )
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('rule evaluation against published facts and rules in real PostgreSQL', () => {
  let meterStatementId: Uuid
  let nameplateStatementId: Uuid
  let firmwareStableId: Uuid
  let firmwareBetaId: Uuid

  it('loads published entity attributes and rule ASTs from the real store and evaluates AND/OR/unknown/conflict', async () => {
    const seedPublication = randomUUID()
    const soc = statementFor(
      'battery.soc_pct',
      { amount: '20.0', unit: 'pct' },
      seedPublication,
      { unitCode: 'pct', validity: { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-21T12:00:00Z' } },
    )
    const grid = statementFor('site.grid_connected', true, seedPublication)
    const meter = statementFor('device.battery_present', true, seedPublication)
    const nameplate = statementFor('device.battery_present', true, seedPublication)
    const stable = statementFor('device.firmware_channel', 'stable', seedPublication)
    const beta = statementFor('device.firmware_channel', 'beta', seedPublication)
    meterStatementId = meter.statementId
    nameplateStatementId = nameplate.statementId
    firmwareStableId = stable.statementId
    firmwareBetaId = beta.statementId

    const reserveReady = ruleVersionFor(
      'rule.reserve-ready',
      DEVICE_SUBJECT.objectId,
      {
        op: 'all',
        operands: [
          { op: 'compare', attributeId: 'battery.soc_pct', operator: 'gte', value: '20.0', unitCode: 'pct', spans: [] },
          { op: 'compare', attributeId: 'site.grid_connected', operator: 'eq', value: true, spans: [] },
        ],
        spans: [],
      },
      seedPublication,
    )
    const batteryPresent = ruleVersionFor(
      'rule.battery-present',
      DEVICE_SUBJECT.objectId,
      { op: 'compare', attributeId: 'device.battery_present', operator: 'eq', value: true, spans: [] },
      seedPublication,
    )
    const firmwareChannel = ruleVersionFor(
      'rule.firmware-channel',
      DEVICE_SUBJECT.objectId,
      { op: 'compare', attributeId: 'device.firmware_channel', operator: 'ne', value: '', spans: [] },
      seedPublication,
    )
    const missingFact = ruleVersionFor(
      'rule.missing-fact',
      DEVICE_SUBJECT.objectId,
      { op: 'compare', attributeId: 'device.unreported_attribute', operator: 'eq', value: true, spans: [] },
      seedPublication,
    )

    await publishBundle(
      [soc, grid, meter, nameplate, stable, beta],
      [reserveReady, batteryPresent, firmwareChannel, missingFact],
      'rule-evaluator-seed',
    )

    const facts = await loadFacts()
    expect(facts).toHaveLength(6)
    const compilation = await loadRules(facts)
    expect(compilation.issues).toEqual([])
    expect(compilation.instances).toHaveLength(4)

    const evaluator = new RuleEvaluator()
    const result = evaluator.evaluate({
      scopeRef: scope.scopeRef,
      request: {
        scopeRef: scope.scopeRef,
        projectionRef: { id: 'projection.semantic', version: '1.0.0', digest: DIGEST },
        validAt: '2026-09-21T06:00:00Z',
      },
      definitionRef: SCHEMA_REF,
      complete: true,
      facts,
      rules: publishedRules(compilation),
    })

    const byKey = new Map(result.conclusions.map((conclusion) => [conclusion.propositionKey, conclusion]))
    const reserveInstance = compilation.instances.find((instance) => instance.ruleId === 'rule.reserve-ready')
    if (reserveInstance === undefined) throw new Error('reserve-ready rule did not compile')
    expect(reserveInstance.supportRule.premiseGroups).toHaveLength(2)
    const reserve = applicabilityFor(result, 'rule.reserve-ready')
    expect(reserve.state).toBe('applicable')
    expect(reserve.conditionState).toBe('true')
    expect(byKey.get(reserve.propositionKey)?.domainStatus).toBe('known')
    expect(byKey.get(reserve.propositionKey)?.value).toBe(true)
    expect(byKey.get(reserve.propositionKey)?.satisfiedBy).toHaveLength(2)

    const batteryInstance = compilation.instances.find((instance) => instance.ruleId === 'rule.battery-present')
    if (batteryInstance === undefined) throw new Error('battery-present rule did not compile')
    const batteryGroupId = batteryInstance.supportRule.premiseGroups[0]?.groupId
    if (batteryGroupId === undefined) throw new Error('battery-present rule has no premise group')
    const battery = applicabilityFor(result, 'rule.battery-present')
    expect(byKey.get(battery.propositionKey)?.domainStatus).toBe('known')
    expect(byKey.get(battery.propositionKey)?.value).toBe(true)
    expect(byKey.get(battery.propositionKey)?.satisfiedBy).toEqual([
      {
        groupId: batteryGroupId,
        alternativeIds: [
          attributeAssertionId(meterStatementId, 'device.battery_present'),
          attributeAssertionId(nameplateStatementId, 'device.battery_present'),
        ].sort(),
      },
    ])

    const firmware = applicabilityFor(result, 'rule.firmware-channel')
    expect(firmware.state).toBe('conflict')
    expect(byKey.get(firmware.propositionKey)?.domainStatus).toBe('conflict')
    expect(byKey.get(firmware.propositionKey)?.value).toBeUndefined()
    const conflict = result.conflicts.find((entry) => entry.propositionKey === 'device.firmware_channel')
    expect(conflict?.assertionIds).toEqual([
      attributeAssertionId(firmwareBetaId, 'device.firmware_channel'),
      attributeAssertionId(firmwareStableId, 'device.firmware_channel'),
    ].sort())

    const unknown = applicabilityFor(result, 'rule.missing-fact')
    expect(unknown.conditionState).toBe('unknown')
    expect(unknown.state).toBe('unknown')
    expect(byKey.get(unknown.propositionKey)?.domainStatus).toBe('unknown')
    expect(byKey.get(unknown.propositionKey)?.value).toBeUndefined()
  })

  it('keeps the conclusion when one of two equivalent published sources is retracted', async () => {
    const statement = await store.getStatement(scope.scopeRef, nameplateStatementId, ctx)
    expect(statement).toBeDefined()
    await store.reviseStatement(
      scope.scopeRef,
      {
        expectedRevision: statement?.version ?? '1',
        revisionId: randomUUID(),
        statementId: nameplateStatementId,
        kind: 'retraction',
        reason: 'the nameplate source was withdrawn',
        recordedAt: '2026-09-21T07:00:00Z',
        actor: ctx.principal.subjectId,
        outbox: {
          outboxId: randomUUID(),
          topic: 'semantic.statement.retracted',
          payload: { statementId: nameplateStatementId },
          idempotencyKey: `retract-${nameplateStatementId}`,
          availableAt: '2026-09-21T07:00:00Z',
          createdAt: '2026-09-21T07:00:00Z',
        },
      },
      ctx,
    )

    const facts = await loadFacts()
    const compilation = await loadRules(facts)
    const result = new RuleEvaluator().evaluate({
      scopeRef: scope.scopeRef,
      request: {
        scopeRef: scope.scopeRef,
        projectionRef: { id: 'projection.semantic', version: '1.0.0', digest: DIGEST },
        validAt: '2026-09-21T06:00:00Z',
      },
      definitionRef: SCHEMA_REF,
      complete: true,
      facts,
      rules: publishedRules(compilation),
    })
    const batteryApplicability = applicabilityFor(result, 'rule.battery-present')
    const battery = result.conclusions.find((conclusion) => conclusion.propositionKey === batteryApplicability.propositionKey)
    expect(battery?.domainStatus).toBe('known')
    expect(battery?.value).toBe(true)
    expect(battery?.satisfiedBy).toEqual([
      {
        groupId: compilation.instances.find((instance) => instance.ruleId === 'rule.battery-present')?.supportRule.premiseGroups[0]?.groupId,
        alternativeIds: [attributeAssertionId(meterStatementId, 'device.battery_present')],
      },
    ])
  })

  it('is deterministic for the same published inputs', async () => {
    const facts = await loadFacts()
    const compilation = await loadRules(facts)
    const request = {
      scopeRef: scope.scopeRef,
      projectionRef: { id: 'projection.semantic', version: '1.0.0', digest: DIGEST },
      validAt: '2026-09-21T06:00:00Z',
    }
    const evaluator = new RuleEvaluator()
    const first = evaluator.evaluate({ scopeRef: scope.scopeRef, request, definitionRef: SCHEMA_REF, complete: true, facts, rules: publishedRules(compilation) })
    const second = evaluator.evaluate({ scopeRef: scope.scopeRef, request, definitionRef: SCHEMA_REF, complete: true, facts, rules: publishedRules(compilation) })
    expect(first).toEqual(second)
    expect(first.inputDigest).toBe(second.inputDigest)
    expect(first.conclusions.some((conclusion) => conclusion.ruleRefs.length > 0)).toBe(true)
    expect(first.conclusions.some((conclusion) => conclusion.factRefs.length > 0)).toBe(true)
  })

  it('rejects a published rule that uses explicit negation', async () => {
    const negationPublication = randomUUID()
    await publishBundle(
      [],
      [
        ruleVersionFor(
          'rule.negated',
          'device.negated',
          {
            op: 'not',
            operand: { op: 'compare', attributeId: 'device.battery_present', operator: 'eq', value: true, spans: [] },
            spans: [],
          },
          negationPublication,
        ),
      ],
      'rule-evaluator-negation',
    )

    const versions = await store.listRuleVersions(scope.scopeRef, { limit: 1_000 }, ctx)
    const negated = versions.find((version) => version.ruleId === 'rule.negated')
    expect(negated).toBeDefined()
    if (negated === undefined) return
    let thrown: unknown
    try {
      supportRuleFromPublishedRule(negated, [])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RuleEvaluationError)
    expect((thrown as RuleEvaluationError).code).toBe('UNSUPPORTED_NEGATION')
  })

  it('scopes the published read view by tenant/space', async () => {
    const other = await createJobScope(harness.adminClient, 'rule-evaluator-other')
    const otherCtx = toolContext(other.tenantId, other.spaceId, ['semantic-publisher', 'platform-admin'])
    const otherStatements = await store.listStatements(other.scopeRef, { limit: 1_000 }, otherCtx)
    expect(otherStatements).toHaveLength(0)
    expect(scope.scopeRef.tenantId).not.toBe(other.scopeRef.tenantId)
  })
})
