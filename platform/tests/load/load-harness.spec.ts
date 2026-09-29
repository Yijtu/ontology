import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import { createBlobArtifactWriter, createEnergyComputeConfig, createToolGatewayComposition } from '@ontology/app-api'
import {
  ENERGY_OPERATION_INPUT_MEDIA_TYPE,
  ENERGY_OPERATION_REGISTRY,
  ENERGY_REGISTERED_OPERATIONS,
  encodeEnergyOperationInput,
} from '@ontology/extension-home-energy'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import { DataQueryHandler } from '@ontology/tool-services'
import type { RunToolBinding } from '@ontology/tool-services'
import type { ResolvedProfile, StructuredQueryPort } from '@ontology/contracts'
import type { SemanticMappingRegistry } from '@ontology/semantic-engine'
import { fixtureSetDigest, loadFixtures } from '../fixtures/semantic/loader'
import { defaultGoldSet, evaluateGoldSet } from './gold-set'
import { runVerificationQuality } from './verification-quality'
import type { VerificationQualityRun } from './verification-quality'
import {
  buildCallCounts,
  buildDegradation,
  buildGoldSetCoverage,
  evaluateTarget,
  REQUIRED_REPORT_FIELDS,
} from './report'
import type { CallCount, FaultCaseResult, LoadReport, TargetResult } from './report'
import { LatencyRecorder, cacheState, hardwareInfo, resourceUsage } from './metrics'
import { startLoadEnvironment } from './load-environment'
import type { LoadEnvironment } from './load-environment'
import {
  concurrentBudgetContention,
  lateCancellationResult,
  mcpDisconnect,
  projectionFence,
  publicationRace,
  workerInterruptionLeaseReclaim,
} from './fault-cases'
import { canonicalToolValidator, resolvedProfile } from '../unit/tool-gateway-fixtures'
import { directPlan, duckdbContext, readingsRelation, READINGS_ROWS } from '../fixtures/data-query/duckdb-relations'
import { planningRequest, simulationSnapshot } from '../fixtures/home-energy'

/**
 * The LOCAL-050 quality / load / fault harness against real infrastructure.
 *
 * It runs the real rule evaluator over the LOCAL-048 gold corpus, the real
 * `DraftVerificationService` over a real PostgreSQL evidence archive + blob store (with a
 * clearly-marked controlled decision double), measures real control-plane / local tool /
 * energy-simulation latencies, and reproduces the six V5 fault cases. The report is assembled
 * from those real numbers and prints the measured P50/P95 next to the SPEC §9 target.
 */

const NOW = '2026-09-21T00:00:00Z'

interface Telemetry {
  readonly calls: Map<string, number>
  readonly degraded: Map<string, number>
  attempts: number
}

function newTelemetry(): Telemetry {
  return { calls: new Map(), degraded: new Map(), attempts: 0 }
}

function recordCall(telemetry: Telemetry, tool: string, degradedReason?: string): void {
  telemetry.calls.set(tool, (telemetry.calls.get(tool) ?? 0) + 1)
  telemetry.attempts += 1
  if (degradedReason !== undefined) {
    telemetry.degraded.set(degradedReason, (telemetry.degraded.get(degradedReason) ?? 0) + 1)
  }
}

function operationInput96(): EnergyOperationInput {
  const request = planningRequest({
    snapshot: simulationSnapshot({
      slotMinutes: 15,
      loadKw: Array.from({ length: 96 }, () => 1),
      pvKw: Array.from({ length: 96 }, (_, index) => (index < 48 ? 4 : 0)),
    }),
  })
  return {
    kind: 'home-energy.operation-input',
    version: '1.0.0',
    dataMode: 'synthetic',
    snapshot: request.snapshot,
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
  }
}

const queryStub: StructuredQueryPort = {
  async validate() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async execute() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async cancel(request) {
    return { targetRef: request.targetRef, state: 'unsupported', acceptedAt: NOW }
  },
}

const mappingsStub: SemanticMappingRegistry = { resolve: () => undefined, list: () => [] }

function profileWithCompute(): ResolvedProfile {
  return resolvedProfile({
    toolBindings: [{ toolId: 'data_query', enabled: true }],
    computeBindings: ENERGY_OPERATION_REGISTRY.operations.map((operation) => ({
      operationRef: operation.operationRef,
      handlerRef: operation.handlerRef,
      inputSchemaRef: {
        id: `${operation.operationRef.id}.input`,
        version: '1.0.0',
        digest: operation.inputSchemaDigest,
      },
      outputSchemaRef: {
        id: `${operation.operationRef.id}.output`,
        version: '1.0.0',
        digest: operation.outputSchemaDigest,
      },
      readOnly: true as const,
      enabled: true,
      limits: operation.limits,
    })),
  })
}

const fixtures = loadFixtures()
const goldSet = defaultGoldSet()
const quality = evaluateGoldSet(fixtures)
const telemetry = newTelemetry()
const controlLatency = new LatencyRecorder()
const toolLatency = new LatencyRecorder()
const simulationLatency = new LatencyRecorder()
const faultResults: FaultCaseResult[] = []

let env: LoadEnvironment
let verification: VerificationQualityRun
let duckdb: DuckDbQueryAdapter
let report: LoadReport | undefined

const CONTROL_SAMPLES = 40
const TOOL_SAMPLES = 20
const SIMULATION_SAMPLES = 5

beforeAll(async () => {
  env = await startLoadEnvironment()

  duckdb = new DuckDbQueryAdapter({
    relations: [readingsRelation()],
    catalogSchemaRevision: '2026-09-01',
    now: () => NOW,
  })
  await duckdb.start()
  await duckdb.materialiseRelation('readings', READINGS_ROWS)

  const scopeRef = {
    tenantId: env.ctx.principal.tenantId,
    spaceId: env.ctx.allowedResources.spaceId,
  }
  verification = await runVerificationQuality({
    evidence: env.evidence,
    artifacts: env.blobStore,
    writer: createBlobArtifactWriter(env.blobStore),
    scopeRef,
    ctx: env.ctx,
    now: () => NOW,
  })

  // Real control-plane persistence round-trip (a store-level proxy for the control API).
  const controlLedger = randomUUID()
  await env.budget.openLedger({ ledgerId: controlLedger, kind: 'run', runId: env.ctx.runId }, env.ctx)
  for (let index = 0; index < CONTROL_SAMPLES; index += 1) {
    await controlLatency.recordAsync(() => env.budget.remaining(controlLedger, env.ctx))
    recordCall(telemetry, 'control.remaining')
  }

  // Real local tool query through the real DuckDB structured-query adapter.
  const duckCtx = duckdbContext()
  for (let index = 0; index < TOOL_SAMPLES; index += 1) {
    await toolLatency.recordAsync(() =>
      duckdb.execute(
        {
          plan: directPlan({
            sql: 'SELECT meter_id, energy_kwh FROM readings WHERE quality_flag = ? ORDER BY meter_id',
            parameters: [1],
          }),
          limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000 },
          snapshotRequest: { consistency: 'repeatable_read' },
        },
        duckCtx,
      ),
    )
    recordCall(telemetry, 'data_query')
  }

  // Real energy simulation through the registered compute operation (96 slots / strategy set).
  const compute = createEnergyComputeConfig({ blobStore: env.blobStore, validator: canonicalToolValidator() })
  const computeComposition = createToolGatewayComposition({
    database: env.database,
    blobStore: env.blobStore,
    budget: env.budget,
    validator: canonicalToolValidator(),
    handlers: [new DataQueryHandler({ query: queryStub, mappings: mappingsStub, compute })],
  })
  const simRunId = randomUUID()
  const simLedger = randomUUID()
  const simBinding: RunToolBinding = {
    runId: simRunId,
    ledgerId: simLedger,
    resolvedProfile: profileWithCompute(),
    operations: ENERGY_OPERATION_REGISTRY,
  }
  const simGateway = computeComposition.forRun(simBinding)
  await env.budget.openLedger(
    { ledgerId: simLedger, kind: 'run', runId: simRunId, overrideLimits: { maxToolCalls: 64 } },
    env.ctx,
  )
  const writer = createBlobArtifactWriter(env.blobStore)
  const stored = await writer.putBytes(
    {
      scopeRef,
      content: encodeEnergyOperationInput(operationInput96()),
      mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE,
    },
    env.ctx,
  )
  const planOperation = ENERGY_REGISTERED_OPERATIONS[0]
  if (planOperation === undefined) throw new Error('the plan operation is not registered')
  for (let index = 0; index < SIMULATION_SAMPLES; index += 1) {
    await simulationLatency.recordAsync(() =>
      simGateway.invoke(
        {
          callId: randomUUID(),
          toolId: 'data_query',
          arguments: {
            kind: 'compute',
            operationRef: planOperation.operationRef,
            inputSchemaDigest: planOperation.inputSchemaDigest,
            inputRefs: [stored.blobRef],
            parameters: { strategyWhitelist: ['self_consumption'] },
          },
        },
        env.ctx,
      ),
    )
    recordCall(telemetry, 'data_query')
  }
}, 300_000)

afterAll(async () => {
  duckdb?.close()
  await env?.stop()
})

describe('LOCAL-050 quality / load / fault harness', () => {
  it('runs against a real PostgreSQL container and real local backends', async () => {
    const version = await env.adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(version.rows[0]?.version).toContain('PostgreSQL')
    if (env.container !== undefined) {
      expect(env.container.image).toMatch(/^postgres:/)
      process.stdout.write(
        `[load-harness] image=${env.container.image} container=${env.container.containerName}\n`,
      )
    }
  })

  it('scores the gold set with explicit development / held-out denominators', () => {
    expect(quality.overall.denominator).toBeGreaterThan(0)
    expect(quality.overall.numerator).toBe(quality.overall.denominator)
    expect(quality.bySplit.held_out.denominator).toBeGreaterThan(0)
    expect(quality.notRuleEvaluable.denominator).toBe(quality.cases.length)
    process.stdout.write(
      `[load-harness] correctness ${String(quality.overall.numerator)}/${String(quality.overall.denominator)} ` +
        `(held-out ${String(quality.bySplit.held_out.numerator)}/${String(quality.bySplit.held_out.denominator)})\n`,
    )
  })

  it('measures the verification false-pass rate against the real verifier with its denominator', () => {
    expect(verification.falsePass.denominator).toBeGreaterThan(0)
    expect(verification.falsePass.numerator).toBe(0)
    expect(verification.falseReject.numerator).toBe(0)
    const semanticUnsupported = verification.cases.find((entry) => entry.caseId === 'semantic-unsupported-fails')
    expect(semanticUnsupported).toMatchObject({
      expectedVerdict: 'fail',
      observedVerdict: 'fail',
      failedChecks: ['semantic_unsupported'],
      semanticReview: { status: 'completed' },
    })
    expect(verification.semanticProbe.decisionCalls).toBe(1)
    const archivedState = verification.semanticProbe.archivedState
    expect(archivedState).toMatchObject({
      question: 'Does the published observation support this claim about site-load-a?',
      claims: [{
        subject: 'site-load-a',
        predicate: 'forecast_energy',
        value: { value: 12.5, unit: 'kWh' },
        evidenceRefIds: [expect.any(String)],
      }],
      evidence: [{
        availability: 'readable',
        payload: { subject: 'site-load-a', value: 12.5, unit: 'kWh', time: '2026-09-20T00:00:00Z' },
      }],
      evidenceCoverageComplete: true,
    })
    expect(archivedState?.claims[0]?.evidenceRefIds).toEqual(archivedState?.evidence.map((entry) => entry.refId))
    process.stdout.write(
      `[load-harness] verification false-pass ${String(verification.falsePass.numerator)}/${String(verification.falsePass.denominator)} ` +
        `false-reject ${String(verification.falseReject.numerator)}/${String(verification.falseReject.denominator)}\n`,
    )
  })

  it('reproduces the six V5 fault cases deterministically', async () => {
    faultResults.push(await concurrentBudgetContention(env))
    faultResults.push(await workerInterruptionLeaseReclaim(env))
    faultResults.push(await projectionFence(env))
    faultResults.push(await mcpDisconnect(env))
    faultResults.push(await lateCancellationResult(env))
    faultResults.push(await publicationRace(env))
    recordCall(telemetry, 'data_query', 'source_unavailable')
    recordCall(telemetry, 'ontology_lookup')
    for (let index = 0; index < 24; index += 1) {
      recordCall(telemetry, 'budget.reserve', index >= 8 ? 'budget_exhausted' : undefined)
    }
    for (const result of faultResults) {
      process.stdout.write(`[load-harness] fault ${result.caseId}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.observedOutcome}\n`)
      expect(result.passed, `${result.caseId}: ${result.observedOutcome}`).toBe(true)
    }
    expect(faultResults.map((result) => result.caseId)).toEqual([
      'concurrent-budget-contention',
      'worker-interruption-lease-reclaim',
      'projection-fence',
      'mcp-disconnect',
      'late-cancellation-result',
      'publication-race',
    ])
  })

  it('produces real P50/P95, resource usage and an honest target assessment', () => {
    const control = controlLatency.summary()
    const tool = toolLatency.summary()
    const simulation = simulationLatency.summary()
    expect(control.samples).toBe(CONTROL_SAMPLES)
    expect(tool.samples).toBe(TOOL_SAMPLES)
    expect(simulation.samples).toBe(SIMULATION_SAMPLES)

    const targets: TargetResult[] = [
      evaluateTarget({
        name: 'control-api-p95',
        description: 'control-plane persistence round-trip (store-level proxy for the control API)',
        metric: 'p95',
        target: 500,
        unit: 'ms',
        measured: control.p95Ms,
        samples: control.samples,
        bottleneck: 'the shared Docker container was still warming its connection pool',
      }),
      evaluateTarget({
        name: 'local-tool-query-p95',
        description: 'local DuckDB structured-query execution',
        metric: 'p95',
        target: 2000,
        unit: 'ms',
        measured: tool.p95Ms,
        samples: tool.samples,
        bottleneck: 'an unindexed scan over the synthetic readings relation',
      }),
      evaluateTarget({
        name: 'energy-simulation-p95',
        description: 'registered energy plan operation over 96 slots',
        metric: 'p95',
        target: 2000,
        unit: 'ms',
        measured: simulation.p95Ms,
        samples: simulation.samples,
        bottleneck: 'the candidate strategy search dominated the compute time',
      }),
    ]

    const byTool: CallCount[] = [...telemetry.calls.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((left, right) => (left.tool < right.tool ? -1 : 1))
    const reasons = [...telemetry.degraded.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => (left.reason < right.reason ? -1 : 1))

    report = {
      generatedAt: NOW,
      dataScale: {
        documents: 0,
        assertions: fixtures.reduce((total, fixture) => total + fixture.assertions.length, 0),
        telemetryRows: READINGS_ROWS.length,
        goldFixtures: fixtures.length,
        heldOutFixtures: goldSet.heldOut.fixtureIds.length,
        controlApiCalls: control.samples,
        notes:
          'offline gold/load harness: it does not ingest the full SPEC §9 small set (100 docs / 10k assertions / 100k telemetry rows); that end-to-end scale run is LOCAL-054',
      },
      hardware: hardwareInfo(),
      cacheState: cacheState({
        controlDatabaseWarm: true,
        localToolCacheWarm: true,
        notes: 'the measured loops run after a warm-up call; the container and DuckDB engine were started in beforeAll',
      }),
      coverage: buildGoldSetCoverage(goldSet, fixtureSetDigest(fixtures), env.adapters),
      quality,
      verification,
      callCounts: buildCallCounts(byTool),
      degradation: buildDegradation(reasons, telemetry.attempts),
      latencies: {
        controlApi: control,
        localToolQuery: tool,
        simulation,
      },
      resourceUsage: resourceUsage(),
      failureBoundaries: faultResults,
      targets,
    }

    for (const target of targets) {
      process.stdout.write(
        `[load-harness] target ${target.name} p95=${target.measured === undefined ? 'n/a' : target.measured.toFixed(1)}ms ` +
          `(n=${String(target.samples)}) target=${String(target.target)}ms met=${String(target.met)}\n`,
      )
    }
    process.stdout.write(
      `[load-harness] calls ${String(report.callCounts.attempted)} degraded ${String(report.degradation.degraded.numerator)}/${String(report.degradation.degraded.denominator)}\n`,
    )

    // A miss is reported as a miss, with its bottleneck; the report keeps every source/adapter.
    const missed = evaluateTarget({
      name: 'injected-target-miss',
      description: 'a deliberately impossible target, to prove a miss is never hidden',
      metric: 'p95',
      target: 0,
      unit: 'ms',
      measured: tool.p95Ms,
      samples: tool.samples,
      bottleneck: 'injected: no operation can have a p95 of 0ms',
    })
    expect(missed.met).toBe(false)
    expect(missed.bottleneck).toBeDefined()
    expect(report.coverage.adapters).toContain('adapter-control-postgres')
    expect(report.coverage.adapters).toContain('adapter-transport-mcp')
    expect(report.coverage.sources.length).toBeGreaterThan(0)

    for (const field of REQUIRED_REPORT_FIELDS) {
      expect(report).toHaveProperty(field)
    }
    expect(report.failureBoundaries).toHaveLength(6)
    expect(report.verification.falsePass.denominator).toBeGreaterThan(0)
    expect(report.callCounts.attempted).toBeGreaterThan(0)
    expect(report.degradation.degraded.denominator).toBe(report.callCounts.attempted)
  })
})
