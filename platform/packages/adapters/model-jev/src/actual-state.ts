import { sha256DigestOf } from '@ontology/core'
import type { ResourceRef, Sha256Digest, ToolContext } from '@ontology/contracts'
import type {
  JevActualState,
  JevActualStateResolution,
  JevActualStateResolutionInput,
  JevActualStateResolver,
} from './types'
import { JevStateResolutionError } from './types'

const DEFAULT_MAX_STATE_BYTES = 65_536
const DEFAULT_MAX_STATE_RECORDS = 1_000

export interface ValidatedJevActualState {
  readonly state: JevActualState
  readonly canonicalJson: string
  readonly byteLength: number
  readonly recordCount: number
  readonly digest: Sha256Digest
}

/**
 * Canonical content digest used to bind an immutable state ResourceRef to the actual
 * JSON value that the host resolves. Object keys sort recursively; arrays retain order.
 */
export function jevActualStateDigest(state: JevActualState): Sha256Digest {
  return sha256DigestOf(canonicalizeState(state, Number.MAX_SAFE_INTEGER).canonicalJson)
}

export async function resolveJevActualState(
  resolver: JevActualStateResolver | undefined,
  stateRef: ResourceRef,
  ctx: ToolContext,
  options: {
    readonly maxBytes?: number
    readonly maxRecords?: number
    readonly signal?: AbortSignal
  } = {},
): Promise<ValidatedJevActualState> {
  if (resolver === undefined) throw new JevStateResolutionError('NOT_CONFIGURED')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_STATE_BYTES
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_STATE_RECORDS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new JevStateResolutionError('INVALID_STATE')
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new JevStateResolutionError('INVALID_STATE')
  }
  if (signalAborted(options.signal)) throw new JevStateResolutionError('CANCELLED')
  if (!ctx.allowedResources.resourceKinds.includes(stateRef.kind)) {
    throw new JevStateResolutionError('SCOPE_MISMATCH')
  }

  const input: JevActualStateResolutionInput = {
    stateRef,
    maxBytes,
    maxRecords,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  let resolved: JevActualStateResolution
  try {
    resolved = await resolver.resolve(input, ctx)
  } catch (error) {
    if (error instanceof JevStateResolutionError) throw error
    if (signalAborted(options.signal)) throw new JevStateResolutionError('CANCELLED')
    throw new JevStateResolutionError('UNAVAILABLE')
  }
  if (signalAborted(options.signal)) throw new JevStateResolutionError('CANCELLED')
  if (resolved.complete !== true) throw new JevStateResolutionError('INCOMPLETE')
  if (!sameRef(resolved.resolvedRef, stateRef)) throw new JevStateResolutionError('VERSION_MISMATCH')

  let validated: ValidatedJevActualState
  try {
    validated = canonicalizeState(resolved.state, maxRecords)
  } catch (error) {
    if (error instanceof JevStateResolutionError) throw error
    throw new JevStateResolutionError('INVALID_STATE')
  }
  if (validated.byteLength > maxBytes) throw new JevStateResolutionError('TOO_LARGE')
  if (validated.digest !== stateRef.digest) throw new JevStateResolutionError('DIGEST_MISMATCH')
  return validated
}

function canonicalizeState(value: unknown, maxRecords: number): ValidatedJevActualState {
  let recordCount = 0
  const active = new Set<object>()

  const visit = (current: unknown): JevActualState => {
    recordCount += 1
    if (recordCount > maxRecords) throw new JevStateResolutionError('TOO_LARGE')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new JevStateResolutionError('INVALID_STATE')
      return current
    }
    if (typeof current !== 'object') throw new JevStateResolutionError('INVALID_STATE')
    if (active.has(current)) throw new JevStateResolutionError('INVALID_STATE')
    active.add(current)
    try {
      if (Array.isArray(current)) {
        if (current.length > maxRecords) throw new JevStateResolutionError('TOO_LARGE')
        for (const key of Reflect.ownKeys(current)) {
          if (key === 'length') continue
          if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
            throw new JevStateResolutionError('INVALID_STATE')
          }
          const index = Number(key)
          if (!Number.isSafeInteger(index) || index >= current.length) {
            throw new JevStateResolutionError('INVALID_STATE')
          }
        }
        const result: JevActualState[] = []
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (descriptor === undefined || !('value' in descriptor)) {
            throw new JevStateResolutionError('INVALID_STATE')
          }
          result.push(visit(descriptor.value))
        }
        return result
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      const stringKeys: string[] = []
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string') throw new JevStateResolutionError('INVALID_STATE')
        stringKeys.push(key)
      }
      stringKeys.sort()
      const result: Record<string, JevActualState> = {}
      for (const key of stringKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new JevStateResolutionError('INVALID_STATE')
        }
        Object.defineProperty(result, key, {
          value: visit(descriptor.value),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return result
    } finally {
      active.delete(current)
    }
  }

  const state = visit(value)
  let canonicalJson: string
  try {
    canonicalJson = JSON.stringify(state)
  } catch {
    throw new JevStateResolutionError('INVALID_STATE')
  }
  if (canonicalJson === undefined) throw new JevStateResolutionError('INVALID_STATE')
  const byteLength = new TextEncoder().encode(canonicalJson).byteLength
  const digest = sha256DigestOf(canonicalJson)
  return { state, canonicalJson, byteLength, recordCount, digest }
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest &&
    left.kind === right.kind
  )
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}
