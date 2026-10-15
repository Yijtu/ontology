import {
  assertRegisteredTaskValidationPolicyShape,
} from '@ontology/contracts'
import type {
  RegisteredTaskValidationPolicy,
  Sha256Digest,
  TaskValidationPolicyBinding,
  TaskValidationPolicyRegistryData,
  TaskValidationPolicyStage,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { TaskValidationError } from './task-validation-errors'

/**
 * The trusted registered validation policy registry (SPEC v0.3a §EX-6.1).
 *
 * Composition builds it from server-owned records; the published task binding only
 * carries a policy ref, a registry digest and a report schema ref. `resolve` therefore
 * decides which implementation runs: an unregistered policy, a registry digest that does
 * not match the pinned registry, an unsupported stage or a different report schema is an
 * explicit block. A client or model cannot name an implementation.
 */

const STAGE_ORDER: Readonly<Record<TaskValidationPolicyStage, number>> = { input: 0, result: 1 }

function refKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

function registryRecordKey(record: RegisteredTaskValidationPolicy): string {
  const stages = [...record.stages].sort((left, right) => STAGE_ORDER[left] - STAGE_ORDER[right])
  return `${refKey(record.policyRef)}|${refKey(record.handlerRef)}|${record.handlerDigest}|${stages.join(',')}|${[...record.requiredCapabilities].sort().join(',')}|${String(record.readOnly)}|${refKey(record.reportSchemaRef)}`
}

/**
 * Deterministic digest of the registry content. Records are sorted by a stable key and
 * each stage list is sorted, so the same trusted set always produces the same digest and
 * a changed handler pin/limits/read-only flag produces a different one.
 */
export function taskValidationPolicyRegistryDigest(
  policies: readonly RegisteredTaskValidationPolicy[],
): Sha256Digest {
  const records = [...policies]
    .map((record) => ({ key: registryRecordKey(record), record }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => ({
      policyRef: entry.record.policyRef,
      handlerRef: entry.record.handlerRef,
      handlerDigest: entry.record.handlerDigest,
      stages: [...entry.record.stages].sort((left, right) => STAGE_ORDER[left] - STAGE_ORDER[right]),
      requiredCapabilities: [...entry.record.requiredCapabilities].sort(),
      readOnly: entry.record.readOnly,
      limits: entry.record.limits,
      reportSchemaRef: entry.record.reportSchemaRef,
    }))
  return sha256DigestOf(canonicalJson(records))
}

export class TaskValidationPolicyRegistry implements TaskValidationPolicyRegistryData {
  readonly registryVersion: TaskValidationPolicyRegistryData['registryVersion']
  readonly registryDigest: Sha256Digest
  readonly policies: readonly RegisteredTaskValidationPolicy[]
  readonly #byPolicyRef = new Map<string, RegisteredTaskValidationPolicy>()

  constructor(
    registryVersion: TaskValidationPolicyRegistryData['registryVersion'],
    policies: readonly RegisteredTaskValidationPolicy[],
  ) {
    for (const policy of policies) assertRegisteredTaskValidationPolicyShape(policy)
    const sorted = [...policies].sort((left, right) =>
      registryRecordKey(left) < registryRecordKey(right)
        ? -1
        : registryRecordKey(left) > registryRecordKey(right)
          ? 1
          : 0,
    )
    for (const policy of sorted) {
      const key = refKey(policy.policyRef)
      if (this.#byPolicyRef.has(key)) {
        throw new TaskValidationError(
          'FINALIZATION_CONFLICT',
          `registry declares duplicate policy ${key}`,
        )
      }
      this.#byPolicyRef.set(key, policy)
    }
    this.registryVersion = registryVersion
    this.registryDigest = taskValidationPolicyRegistryDigest(sorted)
    this.policies = sorted
  }

  /**
   * Resolve the trusted implementation a binding points at. The binding's registry digest
   * must equal this registry's digest, so a binding cannot pin a different deployment's
   * handler set.
   */
  resolve(binding: TaskValidationPolicyBinding): RegisteredTaskValidationPolicy {
    if (binding.registryDigest !== this.registryDigest) {
      throw new TaskValidationError(
        'POLICY_REGISTRY_MISMATCH',
        'the policy binding registry digest does not match the trusted registry',
      )
    }
    const key = refKey(binding.policyRef)
    const record = this.#byPolicyRef.get(key)
    if (record === undefined) {
      throw new TaskValidationError('POLICY_NOT_REGISTERED', `policy ${key} is not registered`)
    }
    if (!record.stages.includes(binding.stage)) {
      throw new TaskValidationError(
        'POLICY_STAGE_UNSUPPORTED',
        `policy ${key} does not support the ${binding.stage} stage`,
      )
    }
    if (refKey(record.reportSchemaRef) !== refKey(binding.reportSchemaRef)) {
      throw new TaskValidationError(
        'POLICY_REPORT_SCHEMA_UNSUPPORTED',
        `policy ${key} publishes a different report schema than the binding declares`,
      )
    }
    return record
  }
}
