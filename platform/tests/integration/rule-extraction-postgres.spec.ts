import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresJobStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  CandidateValidationStageHandler,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryIndustrySchemaSource,
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
  encodeExtractionJobRef,
} from '@ontology/application'
import { JobService, JobWorker } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import {
  InMemorySemanticDefinitionStore,
  SemanticDefinitionService,
  projectIndustrySchema,
} from '@ontology/semantic-engine'
import type { ParsedDocument, RuleCandidate, RuleUnhandledCandidate } from '@ontology/contracts'
import type { ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { sampleCoreDraft } from '../unit/semantic-definition-fixtures'
import { CountingGenerationPort, MODEL_REF, generationResponse } from '../unit/extraction-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

vi.setConfig({ testTimeout: 60_000 })

const HIGH_IMPACT_RULE = {
  ruleId: 'device_charger_power_rule',
  objectId: 'device',
  severity: 'hard',
  impact: 'high',
  expression: {
    op: 'all',
    operands: [
      { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'charger' },
      { op: 'not', operand: { op: 'compare', attributeId: 'device_name', operator: 'eq', value: 'retired' } },
      { op: 'compare', attributeId: 'rated_power', operator: 'gte', value: 7.2, unitCode: 'kW' },
    ],
  },
  exceptions: [{ op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'inverter' }],
}

const CYCLIC_RULE = {
  ruleId: 'self_referential',
  objectId: 'device',
  severity: 'soft',
  impact: 'low',
  expression: { op: 'ref', ruleId: 'self_referential' },
}

const CONFLICTING_RULES = [
  {
    ruleId: 'device_is_charger',
    objectId: 'device',
    severity: 'hard',
    impact: 'high',
    expression: { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'charger' },
  },
  {
    ruleId: 'device_is_inverter',
    objectId: 'device',
    severity: 'hard',
    impact: 'high',
    expression: { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'inverter' },
  },
]

let harness: JobDbHarness
let database: ControlPostgresDatabase
let jobStore: PostgresJobStore
let candidateStore: PostgresCandidateStore
let budgetStore: PostgresBudgetLedgerStore
let budget: BudgetService
let jobService: JobService
let definitionService: SemanticDefinitionService
let parseStore: PostgresDocumentParseStore
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let extraction: LocalDocumentExtractionService
let reader: DocumentSpanReader
let objectDir = ''

async function publishAndParse(scope: JobTestScope, ctx: ToolContext, text: string): Promise<ParsedDocument> {
  const bytes = new TextEncoder().encode(text)
  const staged = await blobStore.stage(bytes, { scopeRef: scope.scopeRef }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef: scope.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctx,
  )
  return extraction.parse({ scopeRef: scope.scopeRef, originalRef: published.blobRef }, ctx)
}

async function createAndCompleteParse(
  scope: JobTestScope,
  ctx: ToolContext,
  parsed: ParsedDocument,
  definition: VersionRef,
): Promise<Uuid> {
  const jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'rule-extraction-integration-source',
      documentRef: encodeExtractionJobRef({
        parseId: parsed.parseId,
        parserVersion: parsed.parserVersion,
        definitionRef: definition,
      }),
      pipelineVersion: '1.0.0',
      idempotencyKey: `rule-extraction-job-${jobId.slice(0, 8)}`,
    },
    ctx,
  )
  const now = new Date().toISOString()
  const lease = await jobStore.acquireLease(
    scope.scopeRef,
    { workerId: 'rule-it-setup', now, leaseDurationMs: 0, jobId },
    ctx,
  )
  if (lease === undefined) throw new Error('could not lease the newly created job')
  await jobStore.completeAttempt(
    scope.scopeRef,
    jobId,
    lease.attempt.attemptId,
    { finalStage: 'parsed', completedAt: now },
    ctx,
  )
  return jobId
}

async function runRuleJob(
  text: string,
  fallback: unknown,
): Promise<{
  readonly scope: JobTestScope
  readonly ctx: ToolContext
  readonly parsed: ParsedDocument
  readonly jobId: Uuid
  readonly generation: CountingGenerationPort
  readonly definitionRef: VersionRef
}> {
  const scope = await createJobScope(harness.adminClient, 'rule-extraction')
  const ctx = toolContext(
    scope.tenantId,
    scope.spaceId,
    ['platform-admin', 'data-editor', 'semantic-publisher'],
    'rule-extraction-integration',
  )
  const published = await definitionService.publish(sampleCoreDraft({ scopeRef: scope.scopeRef }), ctx)
  const ref = published.ref
  const parsed = await publishAndParse(scope, ctx, text)
  const jobId = await createAndCompleteParse(scope, ctx, parsed, ref)
  const generation = new CountingGenerationPort(generationResponse(fallback))
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref, schema: projectIndustrySchema(published) }]),
    generation,
    candidates: candidateStore,
    budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: () => '2026-09-22T00:00:02Z',
  })
  const handlers = createExtractionHandlerRegistry([
    new ExtractionStageHandler({ pipeline, parseStore }),
    new CandidateValidationStageHandler({ pipeline, parseStore }),
    new ReviewHandoffStageHandler(),
  ])
  const worker = new JobWorker({
    store: jobStore,
    handlers,
    budget,
    workerId: `rule-it-worker-${jobId.slice(0, 8)}`,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
  await worker.runUntilIdle(scope.scopeRef, ctx)
  return { scope, ctx, parsed, jobId, generation, definitionRef: ref }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  jobStore = new PostgresJobStore(database)
  candidateStore = new PostgresCandidateStore(database)
  budgetStore = new PostgresBudgetLedgerStore(database)
  budget = new BudgetService({
    store: budgetStore,
    control: new ControlPostgresRepository(database),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  })
  jobService = new JobService({ store: jobStore, now: () => new Date().toISOString(), newId: () => randomUUID() })
  definitionService = new SemanticDefinitionService({
    control: new ControlPostgresRepository(database),
    store: new InMemorySemanticDefinitionStore(),
  })

  objectDir = await mkdtemp(join(tmpdir(), 'rule-extraction-integration-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  extraction = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => '2026-09-22T00:00:00Z',
  })
  reader = new DocumentSpanReader({ blobs: blobStore, store: parseStore, now: () => '2026-09-22T00:00:01Z' })
}, 300_000)

afterAll(async () => {
  await parseStore?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

describe('rule candidates against a real PostgreSQL', () => {
  it('extracts span-linked rule candidates as a real job stage and stops at human review', async () => {
    const { scope, ctx, parsed, jobId, generation, definitionRef } = await runRuleJob(
      'SERVICE TERMS\n1.1 A charger is rated at least 7.2 kW.\n1.2 It is not retired and does not apply to inverters.',
      { entities: [], relations: [], rules: [HIGH_IMPACT_RULE], exceptions: [] },
    )

    const job = await jobService.getJob(jobId, ctx)
    expect(job.stage).toBe('awaiting_review')
    expect(generation.callCount).toBe(parsed.chunks.length)

    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    const rules = candidates.filter((candidate): candidate is RuleCandidate => candidate.kind === 'rule')
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.state).toBe('pending_review')
      expect(rule.reviewRequirement).toBe('required')
      expect(rule.objectId).toBe('device')
      expect(rule.expression.op).toBe('all')
      expect(rule.exceptions).toHaveLength(1)
      expect(rule.sourceSpans.length).toBeGreaterThan(0)
      expect(rule.sourceSpans[0]?.parseId).toBe(parsed.parseId)
      expect(rule.inputVersion.definitionRef.digest).toBe(definitionRef.digest)
      expect(rule.usage?.inputTokens).toBe(12)
      // Every element of the AST carries a span back to a real chunk of the parse.
      const chunkIds = new Set(parsed.chunks.map((chunk) => chunk.chunkId))
      if (rule.expression.op === 'all') {
        for (const operand of rule.expression.operands) {
          expect(operand.spans.length).toBeGreaterThan(0)
          expect(chunkIds.has(operand.spans[0]?.chunkId ?? '')).toBe(true)
        }
      }
    }

    // A span round-trips through the real parse store back to the exact chunk text.
    const firstSpan = rules[0]?.sourceSpans[0]
    expect(firstSpan).toBeDefined()
    const chunk = parsed.chunks.find((entry) => entry.chunkId === firstSpan?.chunkId)
    expect(chunk).toBeDefined()
    if (chunk === undefined || firstSpan === undefined) return
    const read = await reader.readSpan({ documentRef: parsed.originalRef, locator: firstSpan.locator }, ctx)
    expect(read.text).toBe(chunk.text)

    // The published definition version is byte-for-byte unchanged by the run.
    const reread = await definitionService.getVersion(
      {
        scopeRef: scope.scopeRef,
        namespace: 'home-energy',
        definitionId: definitionRef.id,
        version: definitionRef.version,
      },
      ctx,
    )
    expect(reread.ref.digest).toBe(definitionRef.digest)

    const reservations = await budgetStore.listReservations(scope.scopeRef, jobId, ctx)
    expect(reservations).toHaveLength(parsed.chunks.length)
    expect(reservations.every((reservation) => reservation.status === 'settled')).toBe(true)
  })

  it('persists an unhandled cyclic rule with its reason instead of a looser rule', async () => {
    const { scope, ctx, jobId } = await runRuleJob('CLAUSE\n2.1 A rule that references itself.', {
      entities: [],
      relations: [],
      rules: [CYCLIC_RULE],
      exceptions: [],
    })

    const candidates = await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)
    expect(candidates.filter((candidate) => candidate.kind === 'rule')).toHaveLength(0)
    const unhandled = candidates.filter(
      (candidate): candidate is RuleUnhandledCandidate => candidate.kind === 'rule_unhandled',
    )
    expect(unhandled.length).toBeGreaterThan(0)
    for (const item of unhandled) {
      expect(item.reason).toBe('CYCLIC_EXPRESSION')
      expect(item.state).toBe('pending_review')
      expect(item.rawExpression).toContain('self_referential')
      expect(item.issues.some((issue) => issue.code === 'RULE_UNSUPPORTED_EXPRESSION')).toBe(true)
    }
  })

  it('persists a conflicting rule pair as an explicit conflict, never picking one', async () => {
    const { scope, ctx, jobId } = await runRuleJob('CLAUSE\n3.1 A device is a charger and an inverter.', {
      entities: [],
      relations: [],
      rules: CONFLICTING_RULES,
      exceptions: [],
    })

    const rules = (await candidateStore.listCandidates(scope.scopeRef, { jobId }, ctx)).filter(
      (candidate): candidate is RuleCandidate => candidate.kind === 'rule',
    )
    expect(rules.length).toBeGreaterThanOrEqual(2)
    const conflicted = rules.filter((rule) => rule.conflicts.length > 0)
    expect(conflicted.length).toBeGreaterThanOrEqual(2)
    for (const rule of conflicted) {
      expect(rule.state).toBe('pending_review')
      expect(rule.issues.some((issue) => issue.code === 'CONFLICTING_RULE')).toBe(true)
    }
  })
})

describe('rule candidate migration', () => {
  it('widens the kind constraint and keeps RLS enabled', async () => {
    const unprotected = await harness.adminClient.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'agent_platform'
          AND c.relkind = 'r'
          AND c.relname = 'extraction_candidates'
          AND c.relrowsecurity = false`,
    )
    expect(unprotected.rows).toEqual([])

    const definition = await harness.adminClient.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'extraction_candidates_kind'
          AND conrelid = 'agent_platform.extraction_candidates'::regclass`,
    )
    const text = definition.rows[0]?.definition ?? ''
    expect(text).toContain('rule')
    expect(text).toContain('rule_unhandled')
  })

  it('re-runs the migration step without applying anything', async () => {
    const report = await runControlMigrations({
      connectionString: harness.adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toEqual([])
    expect(report.skipped).toContain('025_rule_candidates.sql')
  })
})
