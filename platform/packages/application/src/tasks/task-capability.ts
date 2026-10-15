import type {
  CapabilityBlocker,
  OperationRegistry,
  ProjectReadinessKind,
  PublishedTaskBinding,
  ReadinessProjection,
  RegisteredOperation,
  ResolvedCapability,
  Sha256Digest,
  TaskCapabilityStatus,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * Deterministic capability/readiness preflight for one published task binding (SPEC v0.3a
 * §EX-2.1/§EX-6.1).
 *
 * It answers "can this task actually execute here, right now" without executing anything and
 * without trusting the request: a declared capability that is not resolved, a required
 * readiness projection that is not ready, an unbound registered operation, or a result format
 * the deployment cannot represent is reported as an explicit blocker. A missing requirement is
 * never silently dropped to turn a not-ready task into a success.
 */

/** The digest of an exact registered operation record, covering handler/schema/limits pins. */
export function registeredOperationDigest(operation: RegisteredOperation): Sha256Digest {
  return sha256DigestOf(canonicalJson(operation))
}

export interface TaskCapabilityEvaluationInput {
  readonly binding: PublishedTaskBinding
  readonly availableCapabilities: readonly ResolvedCapability[]
  readonly readiness: readonly ReadinessProjection[]
  readonly operations: OperationRegistry
  /** Result schema refs this deployment can render; a task whose result format is missing is not available. */
  readonly supportedResultSchemaRefs: readonly VersionRef[]
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version
}

function readinessCode(kind: ProjectReadinessKind): string {
  return kind === 'document_index' ? 'INDEX_NOT_READY' : 'PROJECT_DATA_NOT_READY'
}

function readinessMessage(kind: ProjectReadinessKind, state: string | undefined): string {
  if (state === undefined) return `${kind} readiness has not been built for this project revision`
  return `${kind} readiness is ${state} for this project revision`
}

export function evaluateTaskCapability(input: TaskCapabilityEvaluationInput): TaskCapabilityStatus {
  const blockers: CapabilityBlocker[] = []
  const resolvedCapabilities = new Set(input.availableCapabilities.map((capability) => capability.name))

  for (const capability of input.binding.requiredCapabilities) {
    if (!resolvedCapabilities.has(capability)) {
      blockers.push({
        code: 'CAPABILITY_NOT_CONFIGURED',
        message: `required capability ${capability} is not configured for this deployment`,
        retryable: false,
        capabilityName: capability,
      })
    }
  }

  const byKind = new Map(input.readiness.map((projection) => [projection.kind, projection]))
  for (const kind of input.binding.requiredReadiness) {
    const projection = byKind.get(kind)
    if (projection === undefined || projection.state !== 'ready') {
      blockers.push({
        code: readinessCode(kind),
        message: readinessMessage(kind, projection?.state),
        retryable: projection?.state !== 'revoked',
        readinessKind: kind,
      })
    }
  }

  if (!input.supportedResultSchemaRefs.some((ref) => sameRef(ref, input.binding.resultSchemaRef))) {
    blockers.push({
      code: 'CAPABILITY_NOT_CONFIGURED',
      message: `result format ${input.binding.resultSchemaRef.id}@${input.binding.resultSchemaRef.version} is not configured for this deployment`,
      retryable: false,
      capabilityName: `result-format:${input.binding.resultSchemaRef.id}@${input.binding.resultSchemaRef.version}`,
    })
  }

  if (input.binding.operationRef !== undefined) {
    const operation = input.operations.operations.find(
      (candidate) =>
        candidate.operationRef.id === input.binding.operationRef?.id &&
        candidate.operationRef.version === input.binding.operationRef.version,
    )
    if (operation === undefined) {
      blockers.push({
        code: 'COMPUTE_CONTRACT_MISMATCH',
        message: `registered operation ${input.binding.operationRef.id}@${input.binding.operationRef.version} is not bound in this deployment`,
        retryable: false,
      })
    } else if (
      input.binding.registeredOperationDigest !== undefined &&
      registeredOperationDigest(operation) !== input.binding.registeredOperationDigest
    ) {
      blockers.push({
        code: 'COMPUTE_CONTRACT_MISMATCH',
        message: 'the registered operation digest does not match the task binding pin',
        retryable: false,
      })
    }
  }

  const state: TaskCapabilityStatus['state'] =
    blockers.length === 0
      ? 'available'
      : blockers.some((blocker) => blocker.code === 'PROJECT_DATA_NOT_READY' || blocker.code === 'INDEX_NOT_READY')
        ? 'not_ready'
        : 'unavailable'

  return {
    schemaVersion: 'task-capability-status@1',
    taskBindingRef: input.binding.taskBindingRef,
    state,
    requiredCapabilities: [...input.binding.requiredCapabilities],
    requiredReadiness: [...input.binding.requiredReadiness],
    blockers,
  }
}
