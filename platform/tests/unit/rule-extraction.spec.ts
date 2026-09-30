import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  CandidateRecord,
  DocumentChunkRecord,
  RuleCandidate,
  RuleUnhandledCandidate,
  ToolContext,
} from '@ontology/contracts'
import type { ExtractionInput, ExtractionRunContext, JobStageHandler } from '@ontology/application'
import {
  CandidateValidationStageHandler,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryCandidateStore,
  InMemoryIndustrySchemaSource,
  ReviewHandoffStageHandler,
  createExtractionHandlerRegistry,
  encodeExtractionJobRef,
} from '@ontology/application'
import { JobService, JobWorker, InMemoryJobStore } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'
import { createBudgetHarness, ManualClock } from './job-fixtures'
import {
  CountingGenerationPort,
  DEFINITION_REF,
  JOB_ID,
  LEDGER_ID,
  MODEL_REF,
  PARSE_ID,
  PARSER_VERSION,
  StaticDocumentParseStore,
  buildIndustrySchema,
  chunkOf,
  generationResponse,
  textSpan,
} from './extraction-fixtures'

const EDITOR_CTX: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'rule-unit')

function inputOf(
  chunks: readonly DocumentChunkRecord[],
  overrides: Partial<ExtractionInput> = {},
): ExtractionInput {
  return {
    jobId: JOB_ID,
    parseId: PARSE_ID,
    parserVersion: PARSER_VERSION,
    pipelineVersion: '1.0.0',
    definitionRef: DEFINITION_REF,
    chunks,
    truncatedChunkIds: [],
    ...overrides,
  }
}

function buildHarness(): {
  readonly pipeline: ExtractionPipeline
  readonly generation: CountingGenerationPort
  readonly candidates: InMemoryCandidateStore
  readonly budget: ReturnType<typeof createBudgetHarness>
  readonly schema: ReturnType<typeof buildIndustrySchema>
  readonly run: ExtractionRunContext
} {
  const budget = createBudgetHarness()
  const candidates = new InMemoryCandidateStore()
  const generation = new CountingGenerationPort()
  const schema = buildIndustrySchema()
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema }]),
    generation,
    candidates,
    budget: budget.budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: () => '2026-09-22T00:00:00Z',
  })
  return {
    pipeline,
    generation,
    candidates,
    budget,
    schema,
    run: { ledgerId: LEDGER_ID, ctx: EDITOR_CTX, signal: new AbortController().signal },
  }
}

function rulePayload(rules: readonly unknown[], exceptions: readonly unknown[] = []): unknown {
  return { entities: [], relations: [], rules, exceptions }
}

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
}

function isRuleRecord(candidate: CandidateRecord): candidate is RuleCandidate | RuleUnhandledCandidate {
  return candidate.kind === 'rule' || candidate.kind === 'rule_unhandled'
}

async function listRuleCandidates(
  candidates: InMemoryCandidateStore,
  kind: 'rule' | 'rule_unhandled',
): Promise<(RuleCandidate | RuleUnhandledCandidate)[]> {
  const all = await candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)
  return all.filter(
    (candidate): candidate is RuleCandidate | RuleUnhandledCandidate =>
      isRuleRecord(candidate) && candidate.kind === kind,
  )
}

describe('rule candidate extraction (SPEC D4.3/D5, US-013)', () => {
  it('keeps an AND/OR rule, negation, unit and applicability scope span-traceable, and an exception from another chunk attached', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunkA = chunkOf('A charger rated at least 7.2 kW that is not retired.', 0)
    const chunkB = chunkOf('This does not apply to inverters.', 1)
    h.generation.enqueue(generationResponse(rulePayload([HIGH_IMPACT_RULE])))
    h.generation.enqueue(
      generationResponse(
        rulePayload([], [
          {
            targetRuleId: 'device_charger_power_rule',
            condition: { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'inverter' },
          },
        ]),
      ),
    )
    const input = inputOf([chunkA, chunkB])
    const schemaBefore = JSON.stringify(h.schema)

    await h.pipeline.extract(input, h.run)
    const validated = await h.pipeline.validate(input, h.run)
    expect(validated.conflicts).toBe(0)

    const rules = (await listRuleCandidates(h.candidates, 'rule')) as RuleCandidate[]
    expect(rules).toHaveLength(1)
    const rule = rules[0]
    expect(rule?.objectId).toBe('device')
    expect(rule?.expression.op).toBe('all')
    expect(rule?.reviewRequirement).toBe('required')
    expect(rule?.state).toBe('pending_review')

    // Every AST element is span-linked back to the chunk it came from.
    const expression = rule?.expression
    expect(expression?.op).toBe('all')
    if (expression?.op !== 'all') return
    expect(expression.operands).toHaveLength(3)
    for (const operand of expression.operands) {
      expect(operand.spans.length).toBeGreaterThan(0)
      expect(operand.spans[0]?.chunkId).toBe(chunkA.chunkId)
      expect(operand.spans[0]?.parseId).toBe(PARSE_ID)
    }
    const unitOperand = expression.operands[2]
    expect(unitOperand?.op).toBe('compare')
    if (unitOperand?.op === 'compare') {
      expect(unitOperand.unitCode).toBe('kW')
      expect(unitOperand.operator).toBe('gte')
    }
    const negation = expression.operands[1]
    expect(negation?.op).toBe('not')

    // The exception lived in a different chunk and stays attached to the rule.
    expect(rule?.exceptions).toHaveLength(1)
    expect(rule?.exceptions[0]?.condition.op).toBe('compare')
    expect(rule?.exceptions[0]?.spans[0]?.chunkId).toBe(chunkB.chunkId)
    expect(rule?.sourceSpans.map((span) => textSpan(span)?.chunkId).sort()).toEqual(
      [chunkA.chunkId, chunkB.chunkId].sort(),
    )
    expect(rule?.usage?.inputTokens).toBe(12)
    expect(rule?.inputVersion.definitionRef.digest).toBe(DEFINITION_REF.digest)
    // Extraction never mutates the published definition.
    expect(JSON.stringify(h.schema)).toBe(schemaBefore)
  })

  it('records a cyclic expression as an unhandled item with the reason and never a looser rule', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('A rule that references itself.', 0)
    h.generation.enqueue(
      generationResponse(
        rulePayload([
          {
            ruleId: 'self_referential',
            objectId: 'device',
            severity: 'soft',
            impact: 'low',
            expression: { op: 'ref', ruleId: 'self_referential' },
          },
        ]),
      ),
    )
    const input = inputOf([chunk])
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)

    expect(await listRuleCandidates(h.candidates, 'rule')).toHaveLength(0)
    const unhandled = (await listRuleCandidates(h.candidates, 'rule_unhandled')) as RuleUnhandledCandidate[]
    expect(unhandled).toHaveLength(1)
    expect(unhandled[0]?.reason).toBe('CYCLIC_EXPRESSION')
    expect(unhandled[0]?.rawExpression).toContain('self_referential')
    expect(unhandled[0]?.state).toBe('pending_review')
    expect(unhandled[0]?.issues.some((issue) => issue.code === 'RULE_UNSUPPORTED_EXPRESSION')).toBe(true)
  })

  it('records an unsupported operator as unhandled instead of widening the condition', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('Use an exclusive-or between two conditions.', 0)
    h.generation.enqueue(
      generationResponse(
        rulePayload([
          {
            ruleId: 'exclusive_rule',
            objectId: 'device',
            severity: 'soft',
            impact: 'low',
            expression: {
              op: 'xor',
              operands: [
                { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'charger' },
                { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'inverter' },
              ],
            },
          },
        ]),
      ),
    )
    const input = inputOf([chunk])
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)

    expect(await listRuleCandidates(h.candidates, 'rule')).toHaveLength(0)
    const unhandled = (await listRuleCandidates(h.candidates, 'rule_unhandled')) as RuleUnhandledCandidate[]
    expect(unhandled[0]?.reason).toBe('UNSUPPORTED_OPERATOR')
  })

  it('records an unrepresentable quantifier as unhandled', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('At least two of the following conditions must hold.', 0)
    h.generation.enqueue(
      generationResponse(
        rulePayload([
          {
            ruleId: 'quantified_rule',
            objectId: 'device',
            severity: 'soft',
            impact: 'low',
            expression: {
              op: 'all',
              quantifier: 'at_least',
              atLeast: 2,
              operands: [
                { op: 'compare', attributeId: 'device_kind', operator: 'eq', value: 'charger' },
                { op: 'compare', attributeId: 'device_name', operator: 'eq', value: 'A' },
              ],
            },
          },
        ]),
      ),
    )
    const input = inputOf([chunk])
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)

    expect(await listRuleCandidates(h.candidates, 'rule')).toHaveLength(0)
    const unhandled = (await listRuleCandidates(h.candidates, 'rule_unhandled')) as RuleUnhandledCandidate[]
    expect(unhandled[0]?.reason).toBe('UNSUPPORTED_QUANTIFIER')
  })

  it('does not drop an unrepresentable exception to keep a looser rule', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunkA = chunkOf('Chargers must be rated at least 7.2 kW.', 0)
    const chunkB = chunkOf('Except under a condition the parser cannot express.', 1)
    h.generation.enqueue(generationResponse(rulePayload([HIGH_IMPACT_RULE])))
    h.generation.enqueue(
      generationResponse(
        rulePayload([], [
          {
            targetRuleId: 'device_charger_power_rule',
            condition: { op: 'xor', operands: [{ op: 'relation', relationId: 'meter_monitors_device' }] },
          },
        ]),
      ),
    )
    const input = inputOf([chunkA, chunkB])
    await h.pipeline.extract(input, h.run)
    await h.pipeline.validate(input, h.run)

    // The rule is NOT published as a looser rule without its exception.
    expect(await listRuleCandidates(h.candidates, 'rule')).toHaveLength(0)
    const unhandled = (await listRuleCandidates(h.candidates, 'rule_unhandled')) as RuleUnhandledCandidate[]
    expect(unhandled).toHaveLength(1)
    expect(unhandled[0]?.reason).toBe('EXCEPTION_UNREPRESENTABLE')
    expect(unhandled[0]?.state).toBe('pending_review')
  })

  it('surfaces a conflicting rule pair explicitly instead of picking one', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('A device is a charger. A device is an inverter.', 0)
    h.generation.enqueue(
      generationResponse(
        rulePayload([
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
        ]),
      ),
    )
    const input = inputOf([chunk])
    await h.pipeline.extract(input, h.run)
    const validated = await h.pipeline.validate(input, h.run)

    expect(validated.conflicts).toBe(2)
    const rules = (await listRuleCandidates(h.candidates, 'rule')) as RuleCandidate[]
    expect(rules).toHaveLength(2)
    for (const rule of rules) {
      expect(rule.conflicts).toHaveLength(1)
      expect(rule.state).toBe('pending_review')
      expect(rule.issues.some((issue) => issue.code === 'CONFLICTING_RULE')).toBe(true)
    }
    // Both are kept; neither is silently resolved.
    const ids = new Set(rules.map((rule) => rule.ruleId))
    expect(ids).toEqual(new Set(['device_is_charger', 'device_is_inverter']))
  })

  it('never auto-publishes a valid-JSON rule; a high-impact rule requires review', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('A soft preference and a hard requirement.', 0)
    h.generation.enqueue(
      generationResponse(
        rulePayload([
          HIGH_IMPACT_RULE,
          {
            ruleId: 'device_name_preference',
            objectId: 'device',
            severity: 'soft',
            impact: 'low',
            expression: { op: 'compare', attributeId: 'device_name', operator: 'ne', value: 'retired' },
          },
        ]),
      ),
    )
    const input = inputOf([chunk])
    const extracted = await h.pipeline.extract(input, h.run)
    expect(extracted.ruleCandidates).toBe(2)
    expect(extracted.unhandledRules).toBe(0)
    await h.pipeline.validate(input, h.run)

    const rules = (await listRuleCandidates(h.candidates, 'rule')) as RuleCandidate[]
    const high = rules.find((rule) => rule.ruleId === 'device_charger_power_rule')
    const low = rules.find((rule) => rule.ruleId === 'device_name_preference')
    expect(high?.reviewRequirement).toBe('required')
    expect(low?.reviewRequirement).toBe('policy_eligible')
    // Both remain candidates awaiting review; extraction publishes nothing.
    expect(rules.every((rule) => rule.state === 'pending_review')).toBe(true)
  })

  it('is idempotent for a duplicate job: a re-run inserts no duplicate rule candidate', async () => {
    const h = buildHarness()
    await h.budget.budget.openLedger({ ledgerId: LEDGER_ID, kind: 'background' }, EDITOR_CTX)
    const chunk = chunkOf('The same rule extracted twice.', 0)
    const input = inputOf([chunk])

    h.generation.enqueue(generationResponse(rulePayload([HIGH_IMPACT_RULE])))
    const first = await h.pipeline.extract(input, h.run)
    h.generation.enqueue(generationResponse(rulePayload([HIGH_IMPACT_RULE])))
    const second = await h.pipeline.extract(input, h.run)

    expect(first.candidateIds).toHaveLength(1)
    expect(second.candidateIds).toHaveLength(1)
    expect(new Set(second.candidateIds)).toEqual(new Set(first.candidateIds))
    expect(await listRuleCandidates(h.candidates, 'rule')).toHaveLength(1)
  })
})

interface RuleJobHarness {
  readonly worker: JobWorker
  readonly jobService: JobService
  readonly candidates: InMemoryCandidateStore
  readonly generation: CountingGenerationPort
  readonly budget: ReturnType<typeof createBudgetHarness>
}

function buildRuleJobHarness(chunks: readonly DocumentChunkRecord[]): RuleJobHarness {
  const budget = createBudgetHarness()
  const store = new InMemoryJobStore()
  const clock = new ManualClock()
  const jobService = new JobService({ store, now: clock.now, newId: () => randomUUID() })
  const candidates = new InMemoryCandidateStore()
  const generation = new CountingGenerationPort()
  const pipeline = new ExtractionPipeline({
    schemaSource: new InMemoryIndustrySchemaSource([{ ref: DEFINITION_REF, schema: buildIndustrySchema() }]),
    generation,
    candidates,
    budget: budget.budget,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 512 },
    now: clock.now,
  })
  const received: JobStageHandler = {
    stage: 'received',
    run: (context) => Promise.resolve({ nextStage: 'parsed', counts: context.job.counts }),
  }
  const parseStore = new StaticDocumentParseStore(chunks)
  const handlers = createExtractionHandlerRegistry([
    received,
    new ExtractionStageHandler({ pipeline, parseStore, now: clock.now, newId: () => randomUUID() }),
    new CandidateValidationStageHandler({ pipeline, parseStore }),
    new ReviewHandoffStageHandler(),
  ])
  const worker = new JobWorker({
    store,
    handlers,
    budget: budget.budget,
    workerId: 'rule-unit-worker',
    now: clock.now,
    newId: () => randomUUID(),
  })
  return { worker, jobService, candidates, generation, budget }
}

async function createRuleJob(jobService: JobService): Promise<void> {
  await jobService.createJob(
    {
      jobId: JOB_ID,
      kind: 'ingestion',
      sourceRef: 'source-1',
      documentRef: encodeExtractionJobRef({
        parseId: PARSE_ID,
        parserVersion: PARSER_VERSION,
        definitionRef: DEFINITION_REF,
      }),
      pipelineVersion: '1.0.0',
      idempotencyKey: 'rule-extraction-job-key-0001',
    },
    EDITOR_CTX,
  )
}

describe('rule extraction as a durable job stage', () => {
  it('retries from the failed extraction stage without re-calling the model, and stops at review', async () => {
    const chunk = chunkOf('A rule extracted after a transient model failure.', 0)
    const h = buildRuleJobHarness([chunk])
    await createRuleJob(h.jobService)

    h.generation.enqueue({ error: new Error('model unavailable') })
    const failed = await h.worker.runOnce(SCOPE_A, EDITOR_CTX)
    expect(failed.disposition).toBe('failed')
    expect(failed.stage).toBe('parsed')

    const afterFailure = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    await h.jobService.retryJob(
      {
        jobId: JOB_ID,
        failedStage: 'parsed',
        idempotencyKey: 'rule-extraction-retry-key-0001',
        expectedRevision: afterFailure.revision,
      },
      EDITOR_CTX,
    )
    h.generation.enqueue(generationResponse(rulePayload([HIGH_IMPACT_RULE])))
    await h.worker.runUntilIdle(SCOPE_A, EDITOR_CTX)

    const finalJob = await h.jobService.getJob(JOB_ID, EDITOR_CTX)
    // A validated rule candidate stops at human review; the worker never publishes it.
    expect(finalJob.stage).toBe('awaiting_review')
    const rules = (await h.candidates.listCandidates(SCOPE_A, { jobId: JOB_ID }, EDITOR_CTX)).filter(
      (candidate) => candidate.kind === 'rule',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]?.state).toBe('pending_review')
    expect(h.generation.callCount).toBe(2)
  })
})
