import { describe, expect, it } from 'vitest'
import {
  TaskValidationError,
  TaskValidationPolicyRegistry,
  TaskValidationService,
  canonicalJson,
  sha256DigestOf,
} from '@ontology/application'
import type {
  ArchivedTaskFinalizationReceipt,
  ArchivedTaskPolicyReport,
  CapabilityLimits,
  PublishedTaskBinding,
  RegisteredTaskValidationPolicy,
  ResolvedCapability,
  ResourceRef,
  ScopedArtifactReader,
  TaskFinalizationReceiptStore,
  TaskPolicyReportStore,
  TaskValidationPolicyBinding,
  TaskValidationPolicyPort,
  TaskValidationPolicyReport,
  TaskValidationRequest,
  VersionRef,
} from '@ontology/contracts'
import type { TaskFinalizationInput } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const POLICY_REF: VersionRef = { id: 'policy.business-invariant', version: '1.0.0', digest: DIGEST_A }
const HANDLER_REF: VersionRef = { id: 'handler.business-invariant', version: '1.0.0', digest: DIGEST_A }
const REPORT_SCHEMA_REF: VersionRef = { id: 'task-policy-report', version: '1.0.0', digest: DIGEST_A }
const RESULT_MANIFEST_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: DIGEST_A,
  kind: 'artifact',
}
const EXECUTION_BINDING_REF: ResourceRef = {
  id: '22222222-3333-4444-8555-666666666666',
  version: '1.0.0',
  digest: DIGEST_A,
  kind: 'plan',
}
const INPUT_SNAPSHOT_REF: ResourceRef = {
  id: '33333333-4444-4555-8666-777777777777',
  version: '1.0.0',
  digest: DIGEST_A,
  kind: 'artifact',
}
const PARAMETERS_REF: ResourceRef = {
  id: '44444444-5555-4666-8777-888888888888',
  version: '1.0.0',
  digest: DIGEST_A,
  kind: 'artifact',
}
const OUTPUT_REF: ResourceRef = {
  id: '55555555-6666-4777-8888-999999999999',
  version: '1.0.0',
  digest: DIGEST_A,
  kind: 'computation',
}

const LIMITS: CapabilityLimits = { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 }
const READER: ScopedArtifactReader = { read: async () => new Uint8Array() }

function capability(name: string): ResolvedCapability {
  return {
    name,
    version: '1.0.0',
    limits: LIMITS,
    consistency: 'repeatable_read',
    cancellation: 'supported',
    pagination: 'cursor',
    supportedDataTypes: ['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json'],
    sourceComponentRef: { id: `${name}-component`, version: '1.0.0', digest: DIGEST_A },
  }
}

let generated = 0
function nextId(): string {
  generated += 1
  const suffix = generated.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${suffix}`
}

function policyBinding(
  stage: 'input' | 'result',
  required = true,
  registryDigestValue: string = defaultRegistryDigest(),
): TaskValidationPolicyBinding {
  return {
    policyRef: POLICY_REF,
    stage,
    required,
    registryDigest: registryDigestValue,
    reportSchemaRef: REPORT_SCHEMA_REF,
  }
}

function registryRecord(overrides: Partial<RegisteredTaskValidationPolicy> = {}): RegisteredTaskValidationPolicy {
  return {
    policyRef: POLICY_REF,
    handlerRef: HANDLER_REF,
    handlerDigest: DIGEST_A,
    stages: ['input', 'result'],
    requiredCapabilities: [],
    readOnly: true,
    limits: LIMITS,
    reportSchemaRef: REPORT_SCHEMA_REF,
    ...overrides,
  }
}

function registryDigest(records: readonly RegisteredTaskValidationPolicy[]): string {
  return new TaskValidationPolicyRegistry('1.0.0', records).registryDigest
}

function registry(records: readonly RegisteredTaskValidationPolicy[] = [registryRecord()]): TaskValidationPolicyRegistry {
  return new TaskValidationPolicyRegistry('1.0.0', records)
}

function defaultRegistryDigest(): string {
  return registryDigest([registryRecord()])
}

function binding(overrides: Partial<PublishedTaskBinding> = {}): PublishedTaskBinding {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingRef: { id: 'task.costing', version: '1.0.0', digest: DIGEST_B },
    actionDefinitionRef: { id: 'definition.costing', version: '1.0.0', digest: DIGEST_A },
    kind: 'compute',
    parameterSchema: { type: 'object' },
    parameterSchemaDigest: DIGEST_A,
    requiredCapabilities: [],
    requiredReadiness: [],
    resultSchemaRef: RESULT_MANIFEST_REF,
    validationPolicies: [policyBinding('input'), policyBinding('result')],
    ...overrides,
  }
}

function reportFor(request: TaskValidationRequest, overrides: Partial<TaskValidationPolicyReport> = {}): TaskValidationPolicyReport {
  const base: TaskValidationPolicyReport = {
    schemaVersion: 'task-policy-report@1',
    policyRef: request.binding.policyRef,
    registryDigest: request.binding.registryDigest,
    reportSchemaRef: request.binding.reportSchemaRef,
    stage: request.stage,
    executionBindingRef: request.executionBindingRef,
    inputSnapshotRef: request.inputSnapshotRef,
    inputSnapshotDigest: request.inputSnapshotDigest,
    parametersRef: request.parametersRef,
    parametersDigest: request.parametersDigest,
    status: 'pass',
    coverage: { returned: 1, truncated: false },
    violations: [],
    dependencyEvidenceRefs: [],
    ...(request.stage === 'result'
      ? { outputArtifactRef: request.outputArtifactRef, outputDigest: request.outputDigest, typedResultManifestRef: request.typedResultManifestRef }
      : {}),
  }
  return { ...base, ...overrides }
}

function inputRequest(bind: TaskValidationPolicyBinding = policyBinding('input')): TaskValidationRequest {
  return {
    stage: 'input',
    binding: bind,
    executionBindingRef: EXECUTION_BINDING_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST_A,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST_A,
    readInput: READER,
    limits: LIMITS,
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
  }
}

function resultRequest(bind: TaskValidationPolicyBinding = policyBinding('result')): TaskValidationRequest {
  return {
    stage: 'result',
    binding: bind,
    executionBindingRef: EXECUTION_BINDING_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST_A,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST_A,
    outputArtifactRef: OUTPUT_REF,
    outputDigest: DIGEST_A,
    typedResultManifestRef: RESULT_MANIFEST_REF,
    readInput: READER,
    limits: LIMITS,
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
  }
}

class StubPolicy implements TaskValidationPolicyPort {
  readonly policyRef: VersionRef
  #behavior: (request: TaskValidationRequest) => TaskValidationPolicyReport | Promise<TaskValidationPolicyReport>

  constructor(policyRef: VersionRef, behavior?: (request: TaskValidationRequest) => TaskValidationPolicyReport | Promise<TaskValidationPolicyReport>) {
    this.policyRef = policyRef
    this.#behavior = behavior ?? ((request) => reportFor(request))
  }

  validate(request: TaskValidationRequest): Promise<TaskValidationPolicyReport> {
    return Promise.resolve(this.#behavior(request))
  }
}

class InMemoryReportStore implements TaskPolicyReportStore {
  readonly entries = new Map<string, ArchivedTaskPolicyReport>()

  async putReport(_scope: unknown, ref: ResourceRef, report: TaskValidationPolicyReport, _ctx: unknown, evidenceRef?: ResourceRef): Promise<void> {
    this.entries.set(key(ref), evidenceRef === undefined ? { ref, report } : { ref, report, evidenceRef })
  }

  async getReport(_scope: unknown, ref: ResourceRef): Promise<ArchivedTaskPolicyReport | undefined> {
    return this.entries.get(key(ref))
  }
}

class InMemoryReceiptStore implements TaskFinalizationReceiptStore {
  readonly entries = new Map<string, ArchivedTaskFinalizationReceipt>()

  async putReceipt(_scope: unknown, ref: ResourceRef, receipt: ArchivedTaskFinalizationReceipt['receipt']): Promise<void> {
    this.entries.set(key(ref), { ref, receipt })
  }

  async getReceipt(_scope: unknown, ref: ResourceRef): Promise<ArchivedTaskFinalizationReceipt | undefined> {
    return this.entries.get(key(ref))
  }
}

function key(ref: ResourceRef): string {
  return `${ref.digest}#${ref.id}#${ref.version}`
}

function service(input: {
  registry?: TaskValidationPolicyRegistry
  policies?: readonly TaskValidationPolicyPort[]
  reports?: InMemoryReportStore
  receipts?: InMemoryReceiptStore
  capabilities?: readonly ResolvedCapability[]
}): { service: TaskValidationService; reports: InMemoryReportStore; receipts: InMemoryReceiptStore } {
  const reports = input.reports ?? new InMemoryReportStore()
  const receipts = input.receipts ?? new InMemoryReceiptStore()
  return {
    service: new TaskValidationService({
      registry: input.registry ?? registry(),
      policies: input.policies ?? [new StubPolicy(POLICY_REF)],
      reports,
      receipts,
      availableCapabilities: input.capabilities ?? [],
      newId: nextId,
    }),
    reports,
    receipts,
  }
}

describe('TaskValidationPolicyRegistry', () => {
  it('computes a deterministic digest that changes when a handler pin changes', () => {
    expect(registryDigest([registryRecord()])).toBe(registryDigest([registryRecord()]))
    expect(registryDigest([registryRecord({ handlerDigest: DIGEST_B })])).not.toBe(registryDigest([registryRecord()]))
  })

  it('resolves a declared policy and blocks wrong digests, unknown refs, stages and report schemas', () => {
    const reg = registry()
    expect(reg.resolve(policyBinding('input')).policyRef).toEqual(POLICY_REF)

    const wrongRegistry: TaskValidationPolicyBinding = { ...policyBinding('input'), registryDigest: DIGEST_B }
    expect(() => reg.resolve(wrongRegistry)).toThrowError(TaskValidationError)

    const unknown: TaskValidationPolicyBinding = {
      ...policyBinding('input'),
      policyRef: { id: 'policy.unknown', version: '1.0.0', digest: DIGEST_A },
    }
    expect(() => reg.resolve(unknown)).toThrowError(TaskValidationError)

    const limited = registry([registryRecord({ stages: ['input'] })])
    expect(() => limited.resolve(policyBinding('result'))).toThrowError(TaskValidationError)

    const otherSchema: TaskValidationPolicyBinding = {
      ...policyBinding('input'),
      reportSchemaRef: { ...REPORT_SCHEMA_REF, digest: DIGEST_B },
    }
    expect(() => reg.resolve(otherSchema)).toThrowError(TaskValidationError)
  })
})

describe('TaskValidationService.validate', () => {
  it('runs a registered policy, validates and archives its report at the canonical digest', async () => {
    const { service: svc, reports } = service({})
    const archived = await svc.validate(inputRequest(), toolContext())
    expect(archived.ref.digest).toBe(sha256DigestOf(canonicalJson(archived.report)))
    expect(reports.entries.has(key(archived.ref))).toBe(true)
    // The report is unambiguous: it points at the exact execution/input/parameter refs.
    expect(archived.report.executionBindingRef).toEqual(EXECUTION_BINDING_REF)
  })

  it('blocks a report that does not match the request digest', async () => {
    const { service: svc } = service({
      policies: [new StubPolicy(POLICY_REF, (request) => reportFor(request, { inputSnapshotDigest: DIGEST_B }))],
    })
    await expect(svc.validate(inputRequest(), toolContext())).rejects.toThrowError(TaskValidationError)
  })

  it('blocks a malformed report before it is archived', async () => {
    const malformed = { schemaVersion: 'task-policy-report@1', status: 'pass' } as unknown as TaskValidationPolicyReport
    const { service: svc, reports } = service({ policies: [new StubPolicy(POLICY_REF, () => malformed)] })
    await expect(svc.validate(inputRequest(), toolContext())).rejects.toThrowError(TaskValidationError)
    expect(reports.entries.size).toBe(0)
  })

  it('blocks a missing handler and a missing declared capability', async () => {
    const emptyPolicies = service({ policies: [] })
    await expect(emptyPolicies.service.validate(inputRequest(), toolContext())).rejects.toThrowError(TaskValidationError)

    const capable = registry([registryRecord({ requiredCapabilities: ['compute'] })])
    const capableBinding = policyBinding('input', true, capable.registryDigest)
    const noCapability = service({ registry: capable })
    await expect(noCapability.service.validate(inputRequest(capableBinding), toolContext())).rejects.toThrowError(
      TaskValidationError,
    )

    const withCapability = service({ registry: capable, capabilities: [capability('compute')] })
    await expect(withCapability.service.validate(inputRequest(capableBinding), toolContext())).resolves.toBeDefined()
  })
})

async function runPolicies(svc: TaskValidationService): Promise<{ input: ArchivedTaskPolicyReport; result: ArchivedTaskPolicyReport }> {
  const input = await svc.validate(inputRequest(), toolContext())
  const result = await svc.validate(resultRequest(), toolContext())
  return { input, result }
}

function finalizeInput(reportRefs: readonly ResourceRef[], overrides: Partial<TaskFinalizationInput> = {}): TaskFinalizationInput {
  return { ...baseFinalize(reportRefs), ...overrides }
}

function baseFinalize(reportRefs: readonly ResourceRef[]): TaskFinalizationInput {
  return {
    taskBinding: binding(),
    executionBindingRef: EXECUTION_BINDING_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST_A,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST_A,
    outputArtifactRefs: [OUTPUT_REF],
    outputDigests: [DIGEST_A],
    typedResultManifestRef: RESULT_MANIFEST_REF,
    typedResultManifestDigest: DIGEST_A,
    policyReportRefs: reportRefs,
  }
}

describe('TaskValidationService.finalize', () => {
  it('builds an acyclic, deterministic receipt from the required passed reports', async () => {
    const { service: svc, receipts } = service({})
    const { input, result } = await runPolicies(svc)

    const first = await svc.finalize(finalizeInput([input.ref, result.ref]), toolContext())
    expect(first.receipt.requiredPolicyBindings).toHaveLength(2)
    expect(first.receipt.policyReportRefs).toHaveLength(2)
    expect(first.receipt.typedResultManifestRef).toEqual(RESULT_MANIFEST_REF)

    // The receipt references the reports; the reports never carry the receipt ref.
    const serializedReports = canonicalJson([input.report, result.report])
    expect(serializedReports.includes(first.ref.id)).toBe(false)

    const second = await svc.finalize(finalizeInput([result.ref, input.ref]), toolContext())
    expect(second.ref.digest).toBe(first.ref.digest)
    expect(receipts.entries.has(key(first.ref))).toBe(true)
  })

  it('blocks when a required report is missing', async () => {
    const { service: svc } = service({})
    const input = await svc.validate(inputRequest(), toolContext())
    await expect(svc.finalize(finalizeInput([input.ref]), toolContext())).rejects.toThrowError(TaskValidationError)
  })

  it('blocks when a required result report failed, is unknown or incomplete', async () => {
    for (const status of ['fail', 'unknown', 'incomplete'] as const) {
      const reports = new InMemoryReportStore()
      const receipts = new InMemoryReceiptStore()
      const svc = new TaskValidationService({
        registry: registry(),
        policies: [
          new StubPolicy(POLICY_REF, (request) =>
            request.stage === 'result' ? reportFor(request, { status }) : reportFor(request),
          ),
        ],
        reports,
        receipts,
        newId: nextId,
      })
      const input = await svc.validate(inputRequest(), toolContext())
      const result = await svc.validate(resultRequest(), toolContext())
      await expect(svc.finalize(finalizeInput([input.ref, result.ref]), toolContext())).rejects.toThrowError(TaskValidationError)
    }
  })

  it('blocks a report that belongs to another run/result', async () => {
    const { service: svc } = service({})
    const { input, result } = await runPolicies(svc)
    await expect(
      svc.finalize(
        finalizeInput([input.ref, result.ref], { typedResultManifestRef: { ...RESULT_MANIFEST_REF, digest: DIGEST_B } }),
        toolContext(),
      ),
    ).rejects.toThrowError(TaskValidationError)
  })

  it('blocks an unbound report and a tampered report digest', async () => {
    const { service: svc, reports } = service({})
    const { input, result } = await runPolicies(svc)

    const unboundReport = reportFor(resultRequest(), {
      policyRef: { id: 'policy.other', version: '1.0.0', digest: DIGEST_A },
    })
    const unboundRef: ResourceRef = {
      id: nextId(),
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(unboundReport)),
      kind: 'computation',
    }
    await reports.putReport(undefined, unboundRef, unboundReport, undefined)
    await expect(svc.finalize(finalizeInput([input.ref, result.ref, unboundRef]), toolContext())).rejects.toThrowError(
      TaskValidationError,
    )

    const tamperedRef: ResourceRef = { ...result.ref, digest: DIGEST_B }
    await expect(svc.finalize(finalizeInput([input.ref, tamperedRef]), toolContext())).rejects.toThrowError(
      TaskValidationError,
    )
  })

  it('refuses to finalize a task binding that declares no validation policies', async () => {
    const { service: svc } = service({})
    const { input, result } = await runPolicies(svc)
    await expect(
      svc.finalize(finalizeInput([input.ref, result.ref], { taskBinding: binding({ validationPolicies: [] }) }), toolContext()),
    ).rejects.toThrowError(TaskValidationError)
  })
})
