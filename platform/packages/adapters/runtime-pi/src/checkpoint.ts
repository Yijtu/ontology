import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ResourceRef, RuntimeCheckpointRef, ToolId } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { PiRuntimeError } from './errors'

/**
 * Runtime-private checkpoint payload (SPEC §4.3, D7.1; C2).
 *
 * The platform-public state (run state, revision, evidence refs) lives in the run store;
 * this blob is the Pi runtime's private continuation data and is never exposed on a public
 * surface. It carries the SDK/adapter identity that produced it, the bounded transcript the
 * Pi `Agent` would continue from, and the evidence refs already collected. A resume refuses
 * to restore it when the runtime kind, adapter version or locked Pi SDK version differ, so a
 * cross-kernel transfer never silently proceeds (the platform must create a new run).
 */
export const CHECKPOINT_SCHEMA_VERSION = 1

export interface CheckpointPayload {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  readonly runtimeKind: string
  /** Adapter version that wrote the checkpoint (mirrors `manifest.version`). */
  readonly runtimeVersion: string
  readonly adapterVersion: string
  /** Locked `@earendil-works/pi-agent-core` version that wrote the checkpoint. */
  readonly sdkVersion: string
  /** Private Pi transcript; the Agent continues from these messages on resume. */
  readonly messages: readonly AgentMessage[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly toolIds: readonly ToolId[]
  readonly completedTurns: number
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
 * `CHECKPOINT_INCOMPATIBLE`/`CHECKPOINT_INVALID` rather than restored best-effort.
 */
export function decodeCheckpoint(bytes: Uint8Array, ref: RuntimeCheckpointRef): CheckpointPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (error) {
    throw new PiRuntimeError('CHECKPOINT_INVALID', 'the checkpoint blob is not valid JSON', {
      cause: error,
    })
  }
  if (!isCheckpointPayload(parsed)) {
    throw new PiRuntimeError('CHECKPOINT_INVALID', 'the checkpoint blob has an unknown shape')
  }
  if (checkpointDigest(parsed) !== ref.stateDigest) {
    throw new PiRuntimeError(
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

function isToolId(value: unknown): value is ToolId {
  return (
    value === 'ontology_lookup' ||
    value === 'data_query' ||
    value === 'document_search' ||
    value === 'web_search'
  )
}

/**
 * Shallow guard for a persisted Pi message. The Agent itself validates message structure
 * when it replays the transcript, so the checkpoint only needs to refuse a blob that is not
 * an array of role-tagged objects.
 */
function isAgentMessage(value: unknown): value is AgentMessage {
  return isRecord(value) && typeof value.role === 'string'
}

function isCheckpointPayload(value: unknown): value is CheckpointPayload {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return false
  if (
    typeof value.runtimeKind !== 'string' ||
    typeof value.runtimeVersion !== 'string' ||
    typeof value.adapterVersion !== 'string' ||
    typeof value.sdkVersion !== 'string'
  ) {
    return false
  }
  if (!Array.isArray(value.messages) || !value.messages.every(isAgentMessage)) return false
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every(isResourceRef)) return false
  if (!Array.isArray(value.toolIds) || !value.toolIds.every(isToolId)) return false
  if (typeof value.completedTurns !== 'number' || !Number.isInteger(value.completedTurns)) {
    return false
  }
  return true
}
