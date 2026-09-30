import { sha256DigestOf } from '@ontology/core'
import { findRegisteredOperation, isToolContext } from '@ontology/contracts'
import type {
  CapabilityLimits,
  ComputationData,
  ComputeFieldBinding,
  ComputeInvocationAttempt,
  ComputeInvocationRecord,
  ComputeInvocationStore,
  ComputeOperationHandler,
  ComputeOperationResult,
  ComputeOutputBindings,
  ComputeOutputBindingsStore,
  ComputeResultArtifact,
  ComputeResultArtifactStore,
  DataQueryOutput,
  DomainResultStatus,
  ImmutableArtifactWriter,
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopedArtifactReader,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  ToolCoverage,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import {
  assertNoComputeBypass,
  computeRequestOf,
  createScopedArtifactReader,
  resolveComputeHandler,
  runComputeWithBudget,
} from '../handlers/compute'
import type { SchemaValidationIssue, ToolSchemaValidator } from '../types'
import { canonicalJson, snapshotFrom } from '../types'
import { ComputeExecutionError } from './errors'

/**
 * Registered compute execution (SPEC v0.3a §EX-6, §5.1 step 3-4, issue V03-031).
 *
 * This is the normal task/gateway/compute chain for a bound compute task: it resolves the exact
 * registered operation, enforces the binding's contract pin, validates the fixed parameters and
 * the approved input refs, and runs the registered handler only through the same bounded helpers
 * the `data_query.kind=compute` gateway path uses. The handler receives a scoped reader (only the
 * fixed input refs), the operation limits, the trusted context and an AbortSignal — never a
 * filesystem path, an arbitrary URL, a code body or a database credential.
 *
 * Execution is keyed by the logical action digest
 * (scope + taskBindingRef + inputSnapshotDigest + parametersDigest + registeredOperationDigest).
 * A completed invocation is read back unchanged on retry; a concurrent duplicate is stopped by a
 * single owner lease; a failure appends an attempt and is explicitly retryable. The archived
 * domain output, the raw output bindings (with unit and currency kept separate) and the
 * `compute-result-artifact@1` wrapper are all written to the control store; the Core typed
 * manifest (V03-032) is what binds the real gateway evidence later.
 */

const DEFAULT_LEASE_MS = 60_000
const COMPLETENESS_COMPLETE = 'complete' as const

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ComputeExecutionError('COMPUTE_SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ComputeExecutionError('COMPUTE_SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

/** The digest of an exact registered operation record (handler/schema/limits pins). */
export function registeredOperationDigest(operation: RegisteredOperation): Sha256Digest {
  return sha256DigestOf(canonicalJson(operation))
}

function resourceKey(ref: ResourceRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

function escapePointerToken(token: string): string {
  return token.replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'the registered compute operation failed'
}

function completenessOf(coverage: ToolCoverage): ComputeFieldBinding['completeness'] {
  if (coverage.truncated) return 'truncated'
  if (coverage.completeness === undefined || coverage.completeness === COMPLETENESS_COMPLETE) return 'complete'
  return 'incomplete'
}

function isComputationPayload(value: unknown): value is DataQueryOutput & { readonly computation: ComputationData } {
  if (!isRecordValue(value) || value['resultKind'] !== 'computation') return false
  const computation = value['computation']
  return (
    isRecordValue(computation) &&
    isRecordValue(computation['resultRef']) &&
    isRecordValue(computation['operationRef']) &&
    isRecordValue(computation['algorithmVersion'])
  )
}

export interface ComputeExecutionInput {
  readonly taskBindingRef: VersionRef
  readonly operationRef: OperationRef
  /** The binding's pin over the whole registered operation record (handler/input/output/limits). */
  readonly registeredOperationDigest: Sha256Digest
  readonly inputSnapshotRef: ResourceRef
  readonly inputSnapshotDigest: Sha256Digest
  readonly parametersRef: ResourceRef
  readonly parametersDigest: Sha256Digest
  readonly parameters: Readonly<Record<string, unknown>>
  /** The fixed approved input refs the handler may read; nothing else is reachable. */
  readonly inputRefs: readonly ResourceRef[]
  /** Inputs the action declares as required; a missing one is an explicit block, never a default. */
  readonly requiredInputRefs?: readonly ResourceRef[]
  /** Effective run limits; defaults to the registered operation limits. */
  readonly limits?: CapabilityLimits
  readonly deadline: Rfc3339UtcTimestamp
  readonly signal: AbortSignal
  /** Optional stable owner id; a duplicate concurrent submission without it is still blocked. */
  readonly ownerId?: Uuid
  readonly leaseMs?: number
}

export interface ComputeExecutionResult {
  readonly invocation: ComputeInvocationRecord
  readonly artifact: ComputeResultArtifact
  readonly bindings: ComputeOutputBindings
  /** Present only for a freshly executed invocation; a reused result reads the wrapper back. */
  readonly payload?: DataQueryOutput
  readonly reused: boolean
}

export interface RegisteredComputeExecutionDependencies {
  readonly operations: OperationRegistry
  readonly handlers: readonly ComputeOperationHandler[]
  /** Immutable writer the registered handler archives its own domain output through. */
  readonly artifacts: ImmutableArtifactWriter
  /** Scoped reader the handler reaches its approved inputs through. */
  readonly reader: ScopedArtifactReader
  readonly validator: ToolSchemaValidator
  readonly invocations: ComputeInvocationStore
  readonly outputBindings: ComputeOutputBindingsStore
  readonly resultArtifacts: ComputeResultArtifactStore
  readonly newId?: () => Uuid
  readonly now?: () => Rfc3339UtcTimestamp
}

export class RegisteredComputeExecutionService {
  readonly #operations: OperationRegistry
  readonly #handlers: readonly ComputeOperationHandler[]
  readonly #artifacts: ImmutableArtifactWriter
  readonly #reader: ScopedArtifactReader
  readonly #validator: ToolSchemaValidator
  readonly #invocations: ComputeInvocationStore
  readonly #bindings: ComputeOutputBindingsStore
  readonly #results: ComputeResultArtifactStore
  readonly #newId: () => Uuid
  readonly #now: () => Rfc3339UtcTimestamp

  constructor(dependencies: RegisteredComputeExecutionDependencies) {
    this.#operations = dependencies.operations
    this.#handlers = dependencies.handlers
    this.#artifacts = dependencies.artifacts
    this.#reader = dependencies.reader
    this.#validator = dependencies.validator
    this.#invocations = dependencies.invocations
    this.#bindings = dependencies.outputBindings
    this.#results = dependencies.resultArtifacts
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async execute(input: ComputeExecutionInput, ctx: ToolContext): Promise<ComputeExecutionResult> {
    const scopeRef = scopeOf(ctx)
    const operation = this.#resolveOperation(input)
    this.#assertParameters(operation, input.parameters)
    this.#assertRequiredInputs(input)

    const handler = resolveComputeHandler(this.#handlers, input.operationRef)
    if (handler === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_FUNCTION_UNBOUND',
        `no handler is registered for operation ${input.operationRef.id}@${input.operationRef.version}`,
      )
    }
    assertNoComputeBypass(input.parameters, input.inputRefs)

    const logicalKeyDigest = computeLogicalKeyDigest(scopeRef, input)
    const prepared = await this.#invocations.createIfAbsent(
      scopeRef,
      this.#preparedRecord(input, logicalKeyDigest),
      ctx,
    )
    if (prepared.record.state === 'completed') {
      return this.#reuse(scopeRef, prepared.record, ctx)
    }

    const ownerId = input.ownerId ?? this.#newId()
    const leaseExpiresAt = new Date(Date.parse(this.#now()) + (input.leaseMs ?? DEFAULT_LEASE_MS)).toISOString()
    const claimed = await this.#invocations.claim(scopeRef, logicalKeyDigest, ownerId, leaseExpiresAt, ctx)
    if (claimed === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_EXECUTION_IN_PROGRESS',
        'another execution of the same logical compute action currently holds the lease',
        { retryable: true },
      )
    }
    if (claimed.state === 'completed') {
      return this.#reuse(scopeRef, claimed, ctx)
    }

    let result: ComputeOperationResult
    try {
      result = await runComputeWithBudget(
        ({ signal }) =>
          handler.execute(
            computeRequestOf({
              operationRef: input.operationRef,
              parameters: input.parameters,
              inputRefs: input.inputRefs,
              readInput: createScopedArtifactReader(this.#reader, input.inputRefs),
              artifacts: this.#artifacts,
              limits: input.limits ?? operation.limits,
              deadline: input.deadline,
              ctx,
              signal,
            }),
          ),
        operation.limits.maxDurationMs,
        input.deadline,
        input.signal,
      )
    } catch (error) {
      const cancelled = input.signal.aborted
      const attempt: ComputeInvocationAttempt = {
        attempt: claimed.attempt,
        state: cancelled ? 'cancelled' : 'failed',
        code: cancelled ? 'DEADLINE_EXCEEDED' : 'COMPUTE_FUNCTION_FAILED',
        message: messageOf(error),
        retryable: operation.readOnly,
        recordedAt: this.#now(),
      }
      await this.#invocations.fail(scopeRef, logicalKeyDigest, attempt, ctx)
      if (error instanceof ComputeExecutionError) throw error
      throw new ComputeExecutionError(
        'COMPUTE_FUNCTION_FAILED',
        `the registered compute operation ${input.operationRef.id}@${input.operationRef.version} failed: ${attempt.message}`,
        { cause: error, retryable: operation.readOnly },
      )
    }

    return this.#finish(scopeRef, claimed, operation, result, input, ctx)
  }

  #resolveOperation(input: ComputeExecutionInput): RegisteredOperation {
    const operation = findRegisteredOperation(this.#operations, input.operationRef)
    if (operation === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_FUNCTION_UNBOUND',
        `operation ${input.operationRef.id}@${input.operationRef.version} is not registered in this deployment`,
      )
    }
    if (registeredOperationDigest(operation) !== input.registeredOperationDigest) {
      throw new ComputeExecutionError(
        'COMPUTE_CONTRACT_MISMATCH',
        'the registered operation record does not match the task binding pin',
      )
    }
    return operation
  }

  #assertParameters(operation: RegisteredOperation, parameters: Readonly<Record<string, unknown>>): void {
    const validation = this.#validator.validateInline(operation.inputSchema, parameters)
    if (validation.valid) return
    const issues: readonly SchemaValidationIssue[] = validation.issues
    throw new ComputeExecutionError(
      'COMPUTE_PARAMETERS_INVALID',
      `compute parameters do not match the registered operation schema: ${issues
        .map((issue) => `${issue.pointer} ${issue.reason}`)
        .join('; ')}`,
    )
  }

  #assertRequiredInputs(input: ComputeExecutionInput): void {
    const present = new Set(input.inputRefs.map(resourceKey))
    const missing = (input.requiredInputRefs ?? []).filter((ref) => !present.has(resourceKey(ref)))
    if (missing.length > 0) {
      throw new ComputeExecutionError(
        'COMPUTE_INPUT_MISSING',
        `the action is missing required approved inputs: ${missing.map((ref) => ref.id).join(', ')}`,
      )
    }
  }

  #preparedRecord(input: ComputeExecutionInput, logicalKeyDigest: Sha256Digest): ComputeInvocationRecord {
    const now = this.#now()
    return {
      schemaVersion: 'compute-invocation@1',
      invocationId: this.#newId(),
      logicalKeyDigest,
      taskBindingRef: input.taskBindingRef,
      operationRef: input.operationRef,
      registeredOperationDigest: input.registeredOperationDigest,
      inputSnapshotRef: input.inputSnapshotRef,
      inputSnapshotDigest: input.inputSnapshotDigest,
      parametersRef: input.parametersRef,
      parametersDigest: input.parametersDigest,
      state: 'prepared',
      attempt: 1,
      attempts: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  async #reuse(
    scopeRef: ScopeRef,
    record: ComputeInvocationRecord,
    ctx: ToolContext,
  ): Promise<ComputeExecutionResult> {
    if (record.resultRef === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_CONTRACT_MISMATCH',
        'the completed invocation carries no result artifact reference',
      )
    }
    const archived = await this.#results.getArtifact(scopeRef, record.resultRef, ctx)
    if (archived === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_CONTRACT_MISMATCH',
        'the completed invocation result artifact is not archived in this scope',
      )
    }
    const bindings = await this.#bindings.getBindings(scopeRef, archived.artifact.outputBindingsRef, ctx)
    if (bindings === undefined) {
      throw new ComputeExecutionError(
        'COMPUTE_CONTRACT_MISMATCH',
        'the completed invocation output bindings are not archived in this scope',
      )
    }
    return { invocation: record, artifact: archived.artifact, bindings: bindings.bindings, reused: true }
  }

  async #finish(
    scopeRef: ScopeRef,
    invocation: ComputeInvocationRecord,
    operation: RegisteredOperation,
    result: ComputeOperationResult,
    input: ComputeExecutionInput,
    ctx: ToolContext,
  ): Promise<ComputeExecutionResult> {
    if (!isComputationPayload(result.payload)) {
      throw new ComputeExecutionError(
        'COMPUTE_CONTRACT_MISMATCH',
        'the registered handler must return a computation payload with an archived domain output',
      )
    }
    const computation: ComputationData = result.payload.computation
    const outputArtifactRef = computation.resultRef
    const outputDigest = outputArtifactRef.digest
    const domainStatus: DomainResultStatus = result.domainStatus ?? computation.domainStatus
    const coverage = result.coverage
    const bindings: ComputeOutputBindings = this.#buildBindings({
      operation,
      computation,
      input,
      coverage,
      domainStatus,
      dataMode: result.dataMode,
      outputArtifactRef,
      outputDigest,
    })
    const bindingsRef = this.#mintRef(bindings, 'artifact')
    await this.#bindings.putBindings(scopeRef, bindingsRef, bindings, ctx)

    const now = this.#now()
    const artifact: ComputeResultArtifact = {
      schemaVersion: 'compute-result-artifact@1',
      invocationId: invocation.invocationId,
      logicalKeyDigest: invocation.logicalKeyDigest,
      taskBindingRef: input.taskBindingRef,
      operationRef: input.operationRef,
      registeredOperationDigest: input.registeredOperationDigest,
      algorithmVersion: computation.algorithmVersion,
      inputSchemaDigest: operation.inputSchemaDigest,
      outputSchemaDigest: operation.outputSchemaDigest,
      inputSnapshotRef: input.inputSnapshotRef,
      inputSnapshotDigest: input.inputSnapshotDigest,
      parametersRef: input.parametersRef,
      parametersDigest: input.parametersDigest,
      inputRefs: [...input.inputRefs],
      outputArtifactRef,
      outputDigest,
      outputBindingsRef: bindingsRef,
      sourceSnapshots: result.sources.map((source) => snapshotFrom(source, now, outputDigest, outputArtifactRef)),
      dependencyEvidenceRefs: [],
      coverage,
      domainStatus,
      dataMode: result.dataMode,
    }
    const artifactRef = this.#mintRef(artifact, 'computation')
    await this.#results.putArtifact(scopeRef, artifactRef, artifact, ctx)
    const completed = await this.#invocations.complete(
      scopeRef,
      invocation.logicalKeyDigest,
      { resultRef: artifactRef, resultDigest: artifactRef.digest },
      ctx,
    )
    return { invocation: completed, artifact, bindings, payload: result.payload, reused: false }
  }

  #buildBindings(input: {
    readonly operation: RegisteredOperation
    readonly computation: ComputationData
    readonly input: ComputeExecutionInput
    readonly coverage: ToolCoverage
    readonly domainStatus: DomainResultStatus
    readonly dataMode: ComputeOutputBindings['dataMode']
    readonly outputArtifactRef: ResourceRef
    readonly outputDigest: Sha256Digest
  }): ComputeOutputBindings {
    const metrics = input.computation.metrics ?? {}
    const completeness = completenessOf(input.coverage)
    const inputRefPointers = input.input.inputRefs.map((_ref, index) => `/inputRefs/${String(index)}`)
    const fields: ComputeFieldBinding[] = Object.entries(metrics).map(([key, value]) => {
      const record = isRecordValue(value) ? value : undefined
      return {
        rowKey: key,
        columnRef: `metric:${key}`,
        valuePointer: `/metrics/${escapePointerToken(key)}`,
        inputRefPointers: [...inputRefPointers],
        ...(typeof record?.['unit'] === 'string' ? { unit: record['unit'] } : {}),
        ...(typeof record?.['currency'] === 'string' ? { currency: record['currency'] } : {}),
        status: value === null || value === undefined ? 'unknown' : input.domainStatus,
        completeness,
      }
    })
    return {
      schemaVersion: 'typed-output-bindings@1',
      outputArtifactRef: input.outputArtifactRef,
      outputDigest: input.outputDigest,
      outputSchemaRef: {
        id: `${input.operation.operationRef.id}.output`,
        version: input.operation.operationRef.version,
        digest: input.operation.outputSchemaDigest,
      },
      parametersDigest: input.input.parametersDigest,
      inputRefs: [...input.input.inputRefs],
      rowKeys: fields.map((field) => field.rowKey),
      fields,
      coverage: input.coverage,
      domainStatus: input.domainStatus,
      dataMode: input.dataMode,
    }
  }

  #mintRef(body: unknown, kind: ResourceRef['kind']): ResourceRef {
    return {
      id: this.#newId(),
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(body)),
      kind,
    }
  }
}

/** The deterministic logical key of one compute action; the store's idempotency primary key. */
export function computeLogicalKeyDigest(scopeRef: ScopeRef, input: ComputeExecutionInput): Sha256Digest {
  return sha256DigestOf(
    canonicalJson({
      tenantId: scopeRef.tenantId,
      spaceId: scopeRef.spaceId,
      taskBindingRef: input.taskBindingRef,
      inputSnapshotDigest: input.inputSnapshotDigest,
      parametersDigest: input.parametersDigest,
      registeredOperationDigest: input.registeredOperationDigest,
    }),
  )
}
