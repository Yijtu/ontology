import { sha256DigestOf } from '@ontology/core'
import type { ResourceRef, RuntimeCheckpointRef, ToolResultStatus } from '@ontology/contracts'
import { TemplateRuntimeError } from './errors'

/**
 * Runtime-private checkpoint payload (SPEC §4.3, D7.1).
 *
 * The platform-public state (run state, revision, evidence refs) lives in the run store;
 * this blob is the template runtime's private continuation data and is never exposed on a
 * public surface. It records the plan reference and the bounded predecessor outputs so a
 * resume can rebind arguments without re-reading a store: the runtime only ever holds what
 * the gateway already returned inline.
 */
export const CHECKPOINT_SCHEMA_VERSION = 1

export interface CheckpointStepOutput {
  readonly stepId: string
  readonly inlineData: unknown
  readonly evidenceRefs: readonly ResourceRef[]
  readonly status: ToolResultStatus
}

export interface CheckpointPayload {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  readonly runtimeKind: string
  readonly runtimeVersion: string
  readonly planRef: ResourceRef
  readonly completedStepIds: readonly string[]
  readonly stepOutputs: readonly CheckpointStepOutput[]
  readonly evidenceRefs: readonly ResourceRef[]
}

export function checkpointDigest(payload: CheckpointPayload): string {
  return sha256DigestOf(stableStringify(payload))
}

export function encodeCheckpoint(payload: CheckpointPayload): Uint8Array {
  return new TextEncoder().encode(stableStringify(payload))
}

/**
 * Decode and verify a private checkpoint. A blob whose digest does not match its public
 * handle, or whose shape is not a version-1 payload, is refused as
 * `CHECKPOINT_INCOMPATIBLE` rather than restored on a best-effort basis.
 */
export function decodeCheckpoint(bytes: Uint8Array, ref: RuntimeCheckpointRef): CheckpointPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new TemplateRuntimeError('CHECKPOINT_INVALID', 'the checkpoint blob is not valid JSON', {
      cause: error,
    })
  }
  if (!isCheckpointPayload(parsed)) {
    throw new TemplateRuntimeError('CHECKPOINT_INVALID', 'the checkpoint blob has an unknown shape')
  }
  if (checkpointDigest(parsed) !== ref.stateDigest) {
    throw new TemplateRuntimeError(
      'CHECKPOINT_INCOMPATIBLE',
      'the checkpoint blob digest does not match its public handle',
    )
  }
  return parsed
}

/**
 * Deterministic serialization for the private digest. Object keys are sorted and
 * `undefined` object members are dropped (mirroring `JSON.stringify`) so a re-encode of a
 * decoded payload yields the same digest.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResourceRef(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    typeof value.digest === 'string' &&
    typeof value.kind === 'string'
  )
}

function isCheckpointStepOutput(value: unknown): value is CheckpointStepOutput {
  return (
    isRecord(value) &&
    typeof value.stepId === 'string' &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every(isResourceRef) &&
    typeof value.status === 'string'
  )
}

function isCheckpointPayload(value: unknown): value is CheckpointPayload {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return false
  if (typeof value.runtimeKind !== 'string' || typeof value.runtimeVersion !== 'string') return false
  if (!isResourceRef(value.planRef)) return false
  if (
    !Array.isArray(value.completedStepIds) ||
    !value.completedStepIds.every((id) => typeof id === 'string')
  ) {
    return false
  }
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every(isResourceRef)) return false
  if (!Array.isArray(value.stepOutputs) || !value.stepOutputs.every(isCheckpointStepOutput)) {
    return false
  }
  return true
}
