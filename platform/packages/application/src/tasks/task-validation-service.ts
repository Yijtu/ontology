import {
  assertTaskFinalizationReceiptShape,
  assertTaskValidationPolicyReportShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  ArchivedTaskFinalizationReceipt,
  ArchivedTaskPolicyReport,
  PublishedTaskBinding,
  ResolvedCapability,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  TaskFinalizationReceipt,
  TaskFinalizationReceiptStore,
  TaskPolicyEvidenceRecorder,
  TaskPolicyReportStore,
  TaskValidationPolicyBinding,
  TaskValidationPolicyPort,
  TaskValidationPolicyReport,
  TaskValidationRequest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { TaskValidationError } from './task-validation-errors'
import type { TaskValidationPolicyRegistry } from './task-validation-registry'

/**
 * Registered task validation policy execution and acyclic finalization (SPEC v0.3a
 * execution-evidence §EX-6.1, §5.1 step 4).
 *
 * `validate` resolves the trusted implementation from the binding's policy ref/registry
 * digest, checks its declared capabilities, runs it with the run's own limits/deadline/
 * signal and archives the runtime-validated report. `finalize` then builds an independent
 * receipt that binds the required policies, their archived reports and the exact result
 * manifest. The receipt references the reports and the result; the reports and result
 * manifest carry no receipt ref, so the artifact graph has no digest cycle.
 *
 * Missing, failed, unknown or incomplete required reports never form a formal result.
 */

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameResource(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function resourceKey(ref: ResourceRef): string {
  return `${ref.digest}#${ref.id}#${ref.version}`
}

function bindingKey(binding: TaskValidationPolicyBinding): string {
  return `${binding.stage}:${binding.policyRef.id}@${binding.policyRef.version}#${binding.policyRef.digest}`
}

function reportBindingKey(report: TaskValidationPolicyReport): string {
  return `${report.stage}:${report.policyRef.id}@${report.policyRef.version}#${report.policyRef.digest}`
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new TaskValidationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new TaskValidationError('SCOPE_MISMATCH', 'the trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

export interface TaskValidationServiceDependencies {
  readonly registry: TaskValidationPolicyRegistry
  /** Trusted policy implementations, assembled independently of compute/runtime/transport. */
  readonly policies: readonly TaskValidationPolicyPort[]
  readonly reports: TaskPolicyReportStore
  readonly receipts: TaskFinalizationReceiptStore
  /** Capabilities the deployment can actually run; a policy requiring a missing one is blocked. */
  readonly availableCapabilities?: readonly ResolvedCapability[]
  readonly evidence?: TaskPolicyEvidenceRecorder
  readonly newId?: () => Uuid
}

export interface TaskFinalizationInput {
  readonly taskBinding: PublishedTaskBinding
  readonly executionBindingRef: ResourceRef
  readonly inputSnapshotRef: ResourceRef
  readonly inputSnapshotDigest: Sha256Digest
  readonly parametersRef: ResourceRef
  readonly parametersDigest: Sha256Digest
  readonly outputArtifactRefs: readonly ResourceRef[]
  readonly outputDigests: readonly Sha256Digest[]
  readonly typedResultManifestRef: ResourceRef
  readonly typedResultManifestDigest: Sha256Digest
  /** The archived policy reports the caller produced for this run/result. */
  readonly policyReportRefs: readonly ResourceRef[]
}

export class TaskValidationService {
  readonly #registry: TaskValidationPolicyRegistry
  readonly #policies: readonly TaskValidationPolicyPort[]
  readonly #reports: TaskPolicyReportStore
  readonly #receipts: TaskFinalizationReceiptStore
  readonly #availableCapabilities: readonly ResolvedCapability[]
  readonly #evidence: TaskPolicyEvidenceRecorder | undefined
  readonly #newId: () => Uuid

  constructor(dependencies: TaskValidationServiceDependencies) {
    this.#registry = dependencies.registry
    this.#policies = dependencies.policies
    this.#reports = dependencies.reports
    this.#receipts = dependencies.receipts
    this.#availableCapabilities = dependencies.availableCapabilities ?? []
    this.#evidence = dependencies.evidence
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /**
   * Verify every declared policy of a task binding resolves in the trusted registry. Used
   * by preflight so a declared-but-unbound policy leaves the task not ready instead of
   * being silently skipped at result time.
   */
  assertPoliciesRegistered(binding: PublishedTaskBinding): void {
    for (const policy of binding.validationPolicies ?? []) {
      this.#registry.resolve(policy)
    }
  }

  /** Run one registered policy for the given stage, validate and archive its report. */
  async validate(request: TaskValidationRequest, ctx: ToolContext): Promise<ArchivedTaskPolicyReport> {
    const scopeRef = scopeOf(ctx)
    const record = this.#registry.resolve(request.binding)
    const port = this.#findPort(request.binding.policyRef)
    if (!sameVersionRef(port.policyRef, record.policyRef)) {
      throw new TaskValidationError(
        'POLICY_HANDLER_DIGEST_MISMATCH',
        'the assembled handler does not match the registered policy ref',
      )
    }
    this.#assertCapabilities(record.requiredCapabilities)

    const report = await port.validate(request, ctx)
    try {
      assertTaskValidationPolicyReportShape(report)
    } catch (error) {
      throw new TaskValidationError(
        'POLICY_REPORT_INVALID',
        'the policy returned a report that does not match task-policy-report@1',
        { cause: error },
      )
    }
    this.#assertReportMatchesRequest(report, request)

    const reportRef: ResourceRef = {
      id: this.#newId(),
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(report)),
      kind: 'computation',
    }
    const evidenceRef =
      this.#evidence === undefined
        ? undefined
        : await this.#evidence.recordPolicyExecution(
            { scopeRef, executionBindingRef: request.executionBindingRef, reportRef, report },
            ctx,
          )
    await this.#reports.putReport(scopeRef, reportRef, report, ctx, evidenceRef)
    return evidenceRef === undefined ? { ref: reportRef, report } : { ref: reportRef, report, evidenceRef }
  }

  /**
   * Build the independent finalization receipt. Every required policy must have exactly
   * one archived report that points at this same run/result and has status `pass`; any
   * unbound, mismatched, missing, failed, unknown or incomplete report blocks the result.
   */
  async finalize(
    input: TaskFinalizationInput,
    ctx: ToolContext,
  ): Promise<ArchivedTaskFinalizationReceipt> {
    const scopeRef = scopeOf(ctx)
    const declared = input.taskBinding.validationPolicies ?? []
    if (declared.length === 0) {
      throw new TaskValidationError(
        'TASK_HAS_NO_VALIDATION_POLICIES',
        'the task binding declares no validation policies to finalize',
      )
    }
    const declaredKeys = new Set(declared.map(bindingKey))

    const reports: ArchivedTaskPolicyReport[] = []
    const uniqueReportRefs = new Map<string, ResourceRef>()
    for (const ref of input.policyReportRefs) uniqueReportRefs.set(resourceKey(ref), ref)
    for (const reportRef of uniqueReportRefs.values()) {
      const archived = await this.#reports.getReport(scopeRef, reportRef, ctx)
      if (archived === undefined) {
        throw new TaskValidationError(
          'POLICY_REPORT_NOT_ARCHIVED',
          `policy report ${reportRef.id} is not archived in this scope`,
        )
      }
      if (sha256DigestOf(canonicalJson(archived.report)) !== reportRef.digest) {
        throw new TaskValidationError(
          'POLICY_REPORT_TAMPERED',
          `policy report ${reportRef.id} does not hash to its declared digest`,
        )
      }
      if (!declaredKeys.has(reportBindingKey(archived.report))) {
        throw new TaskValidationError(
          'POLICY_REPORT_UNBOUND',
          `policy report ${reportRef.id} does not correspond to a declared policy of this task`,
        )
      }
      this.#assertReportMatchesRun(archived.report, input)
      reports.push(archived)
    }

    const missing: string[] = []
    const notPassed: string[] = []
    for (const binding of declared.filter((policy) => policy.required)) {
      const match = reports.find(
        (archived) =>
          archived.report.stage === binding.stage && sameVersionRef(archived.report.policyRef, binding.policyRef),
      )
      if (match === undefined) {
        missing.push(`${binding.stage} policy ${binding.policyRef.id}@${binding.policyRef.version}`)
        continue
      }
      if (match.report.status !== 'pass') {
        notPassed.push(`${binding.stage} policy ${binding.policyRef.id}@${binding.policyRef.version} reported ${match.report.status}`)
      }
    }
    if (missing.length > 0 || notPassed.length > 0) {
      const reasons = [
        ...missing.map((entry) => `missing required ${entry}`),
        ...notPassed.map((entry) => `required ${entry}`),
      ]
      throw new TaskValidationError(
        missing.length > 0 ? 'TASK_POLICY_REQUIRED_MISSING' : 'TASK_POLICY_NOT_PASSED',
        'the result has unsatisfied required validation policies',
        { reasons },
      )
    }

    const requiredPolicyBindings = sortBindings(declared.filter((policy) => policy.required))
    const policyReportRefs = [...reports]
      .map((archived) => archived.ref)
      .sort((left, right) => (resourceKey(left) < resourceKey(right) ? -1 : 1))
    const outputArtifactRefs = [...input.outputArtifactRefs]
    const receipt: TaskFinalizationReceipt = {
      schemaVersion: 'task-finalization-receipt@1',
      executionBindingRef: input.executionBindingRef,
      taskBindingRef: input.taskBinding.taskBindingRef,
      inputSnapshotRef: input.inputSnapshotRef,
      inputSnapshotDigest: input.inputSnapshotDigest,
      parametersRef: input.parametersRef,
      parametersDigest: input.parametersDigest,
      outputArtifactRefs,
      outputDigests: [...input.outputDigests],
      typedResultManifestRef: input.typedResultManifestRef,
      typedResultManifestDigest: input.typedResultManifestDigest,
      requiredPolicyBindings,
      policyReportRefs,
    }
    const receiptRef: ResourceRef = {
      id: this.#newId(),
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(receipt)),
      kind: 'artifact',
    }
    assertTaskFinalizationReceiptShape(receipt)
    this.#assertAcyclic(receipt, receiptRef, reports)
    await this.#receipts.putReceipt(scopeRef, receiptRef, receipt, ctx)
    return { ref: receiptRef, receipt }
  }

  #findPort(policyRef: VersionRef): TaskValidationPolicyPort {
    const port = this.#policies.find((candidate) => sameVersionRef(candidate.policyRef, policyRef))
    if (port === undefined) {
      throw new TaskValidationError(
        'POLICY_HANDLER_NOT_BOUND',
        `no handler is assembled for policy ${policyRef.id}@${policyRef.version}`,
      )
    }
    return port
  }

  #assertCapabilities(required: readonly string[]): void {
    const available = new Set(this.#availableCapabilities.map((capability) => capability.name))
    const missing = required.filter((name) => !available.has(name))
    if (missing.length > 0) {
      throw new TaskValidationError(
        'POLICY_CAPABILITY_NOT_CONFIGURED',
        `validation policy requires unconfigured capabilities: ${missing.join('; ')}`,
      )
    }
  }

  #assertReportMatchesRequest(report: TaskValidationPolicyReport, request: TaskValidationRequest): void {
    const problems: string[] = []
    if (!sameVersionRef(report.policyRef, request.binding.policyRef)) problems.push('policyRef')
    if (report.registryDigest !== request.binding.registryDigest) problems.push('registryDigest')
    if (!sameVersionRef(report.reportSchemaRef, request.binding.reportSchemaRef)) problems.push('reportSchemaRef')
    if (report.stage !== request.stage) problems.push('stage')
    if (!sameResource(report.executionBindingRef, request.executionBindingRef)) problems.push('executionBindingRef')
    if (!sameResource(report.inputSnapshotRef, request.inputSnapshotRef)) problems.push('inputSnapshotRef')
    if (report.inputSnapshotDigest !== request.inputSnapshotDigest) problems.push('inputSnapshotDigest')
    if (!sameResource(report.parametersRef, request.parametersRef)) problems.push('parametersRef')
    if (report.parametersDigest !== request.parametersDigest) problems.push('parametersDigest')
    if (request.stage === 'result') {
      if (report.outputArtifactRef === undefined || !sameResource(report.outputArtifactRef, request.outputArtifactRef)) {
        problems.push('outputArtifactRef')
      }
      if (report.outputDigest !== request.outputDigest) problems.push('outputDigest')
      if (
        report.typedResultManifestRef === undefined ||
        !sameResource(report.typedResultManifestRef, request.typedResultManifestRef)
      ) {
        problems.push('typedResultManifestRef')
      }
    }
    if (problems.length > 0) {
      throw new TaskValidationError(
        'POLICY_REPORT_MISMATCH',
        `the policy report does not match the request: ${problems.join(', ')}`,
        { reasons: problems },
      )
    }
  }

  #assertReportMatchesRun(report: TaskValidationPolicyReport, input: TaskFinalizationInput): void {
    const problems: string[] = []
    if (!sameResource(report.executionBindingRef, input.executionBindingRef)) problems.push('executionBindingRef')
    if (!sameResource(report.inputSnapshotRef, input.inputSnapshotRef)) problems.push('inputSnapshotRef')
    if (report.inputSnapshotDigest !== input.inputSnapshotDigest) problems.push('inputSnapshotDigest')
    if (!sameResource(report.parametersRef, input.parametersRef)) problems.push('parametersRef')
    if (report.parametersDigest !== input.parametersDigest) problems.push('parametersDigest')
    if (report.stage === 'result') {
      if (
        report.typedResultManifestRef === undefined ||
        !sameResource(report.typedResultManifestRef, input.typedResultManifestRef)
      ) {
        problems.push('typedResultManifestRef')
      }
      const outputRef = report.outputArtifactRef
      if (
        outputRef === undefined ||
        !input.outputArtifactRefs.some((ref) => sameResource(ref, outputRef)) ||
        report.outputDigest === undefined ||
        !input.outputDigests.includes(report.outputDigest)
      ) {
        problems.push('outputArtifactRef')
      }
    }
    if (problems.length > 0) {
      throw new TaskValidationError(
        'POLICY_REPORT_MISMATCH',
        `a policy report does not belong to this run/result: ${problems.join(', ')}`,
        { reasons: problems },
      )
    }
  }

  /**
   * The receipt references the reports and the result; none of them may reference the
   * receipt or form a cycle back into the result manifest.
   */
  #assertAcyclic(
    receipt: TaskFinalizationReceipt,
    receiptRef: ResourceRef,
    reports: readonly ArchivedTaskPolicyReport[],
  ): void {
    const references = [
      receipt.typedResultManifestRef,
      ...receipt.outputArtifactRefs,
      ...receipt.policyReportRefs,
    ]
    if (references.some((ref) => sameResource(ref, receiptRef))) {
      throw new TaskValidationError('FINALIZATION_ACYCLICITY_VIOLATION', 'the receipt references itself')
    }
    if (receipt.policyReportRefs.some((ref) => sameResource(ref, receipt.typedResultManifestRef))) {
      throw new TaskValidationError(
        'FINALIZATION_ACYCLICITY_VIOLATION',
        'a policy report ref collides with the result manifest ref',
      )
    }
    for (const archived of reports) {
      if (sameResource(archived.ref, receipt.typedResultManifestRef)) {
        throw new TaskValidationError('FINALIZATION_ACYCLICITY_VIOLATION', 'a report ref collides with the result manifest')
      }
      if (archived.report.dependencyEvidenceRefs.some((ref) => sameResource(ref, receiptRef))) {
        throw new TaskValidationError('FINALIZATION_ACYCLICITY_VIOLATION', 'a policy report references the receipt')
      }
      if (archived.report.outputArtifactRef !== undefined && sameResource(archived.report.outputArtifactRef, receiptRef)) {
        throw new TaskValidationError('FINALIZATION_ACYCLICITY_VIOLATION', 'a policy report references the receipt as output')
      }
    }
  }
}

function sortBindings(bindings: readonly TaskValidationPolicyBinding[]): TaskValidationPolicyBinding[] {
  return [...bindings].sort((left, right) => (bindingKey(left) < bindingKey(right) ? -1 : 1))
}
