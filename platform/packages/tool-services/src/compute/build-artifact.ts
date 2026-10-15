import { createHash } from 'node:crypto'
import { sha256DigestOf } from '@ontology/core'
import type { ComputeOperationHandler, Sha256Digest } from '@ontology/contracts'
import { canonicalJson } from '../types'
import { ComputeExecutionError } from './errors'

/** Build-time metadata for a closed ESM bundle; source ids are relative, controlled code only. */
export interface ComputeBuildArtifactManifest {
  readonly schemaVersion: 'compute-build-artifact@1'
  readonly format: 'esm-bundle'
  readonly target: 'es2023'
  readonly bundleDigest: Sha256Digest
  readonly byteLength: number
  readonly dependencies: readonly { readonly sourceId: string; readonly digest: Sha256Digest }[]
  readonly handlerDigest: Sha256Digest
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isManifest(value: unknown): value is ComputeBuildArtifactManifest {
  if (!isRecord(value) || value['schemaVersion'] !== 'compute-build-artifact@1' ||
    Object.keys(value).length !== 7 ||
    value['format'] !== 'esm-bundle' || value['target'] !== 'es2023' ||
    typeof value['bundleDigest'] !== 'string' || !DIGEST.test(value['bundleDigest']) ||
    typeof value['handlerDigest'] !== 'string' || !DIGEST.test(value['handlerDigest']) ||
    typeof value['byteLength'] !== 'number' || !Number.isSafeInteger(value['byteLength']) ||
    value['byteLength'] <= 0 || value['byteLength'] > 16_777_216 ||
    !Array.isArray(value['dependencies']) || value['dependencies'].length === 0 ||
    value['dependencies'].length > 1_024) return false
  let previous = ''
  for (const entry of value['dependencies']) {
    if (!isRecord(entry) || typeof entry['sourceId'] !== 'string' ||
      Object.keys(entry).length !== 2 || entry['sourceId'].length > 512 ||
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(entry['sourceId']) ||
      entry['sourceId'].split('/').some((part) => part === '.' || part === '..') ||
      entry['sourceId'] <= previous || typeof entry['digest'] !== 'string' || !DIGEST.test(entry['digest'])) return false
    previous = entry['sourceId']
  }
  return true
}

/** Hash emitted executable bytes and their exact controlled source closure, never a version label. */
export function computeBuildArtifactDigest(manifest: Omit<ComputeBuildArtifactManifest, 'handlerDigest'>): Sha256Digest {
  return sha256DigestOf(canonicalJson(manifest))
}

export function verifyComputeBuildArtifact(manifest: unknown, content: Uint8Array): ComputeBuildArtifactManifest {
  if (!isManifest(manifest)) {
    throw new ComputeExecutionError('COMPUTE_CONTRACT_MISMATCH', 'the compute build artifact manifest is missing or invalid')
  }
  const { handlerDigest, ...body } = manifest
  if (content.byteLength !== manifest.byteLength || `sha256:${createHash('sha256').update(content).digest('hex')}` !== manifest.bundleDigest ||
    computeBuildArtifactDigest(body) !== handlerDigest) {
    throw new ComputeExecutionError('COMPUTE_CONTRACT_MISMATCH', 'the compute build artifact does not match its pinned manifest')
  }
  return manifest
}

export interface ArtifactComputeHandlerOptions {
  readonly manifest: unknown
  /** Host-owned reader for this finite, statically imported artifact; never a model-supplied path. */
  readonly readArtifact: () => Uint8Array
  /** The factory exported by that same statically imported build artifact. No runtime source/DSL. */
  readonly factory: (handlerDigest: Sha256Digest) => readonly ComputeOperationHandler[]
}

/**
 * Trusted composition seam for customer functions compiled into the same closed artifact.
 * The host pairs its static module import with its manifest/byte reader; no function body,
 * package name, path or executable URL enters the compute request contract.
 */
export function createArtifactComputeHandlers(options: ArtifactComputeHandlerOptions): readonly ComputeOperationHandler[] {
  const readArtifact = options.readArtifact
  const verify = (manifest: unknown): ComputeBuildArtifactManifest => {
    try {
      return verifyComputeBuildArtifact(manifest, readArtifact())
    } catch (error) {
      if (error instanceof ComputeExecutionError) throw error
      throw new ComputeExecutionError('COMPUTE_CONTRACT_MISMATCH', 'the compute build artifact is unavailable', { cause: error })
    }
  }
  const manifest = verify(options.manifest)
  const pinnedManifest = Object.freeze({ ...manifest, dependencies: Object.freeze(manifest.dependencies.map((entry) => Object.freeze({ ...entry }))) })
  return options.factory(manifest.handlerDigest).map((handler) => Object.freeze({
    operationRef: Object.freeze({ ...handler.operationRef }),
    artifact: Object.freeze({ handlerDigest: manifest.handlerDigest, assertIntegrity: () => { verify(pinnedManifest) } }),
    execute: handler.execute.bind(handler),
  }))
}

/** Called before both a fresh invocation and a completed invocation read-back. */
export function assertComputeHandlerArtifact(handler: ComputeOperationHandler, registeredDigest: Sha256Digest): void {
  if (handler.artifact === undefined || handler.artifact.handlerDigest !== registeredDigest) {
    throw new ComputeExecutionError('COMPUTE_CONTRACT_MISMATCH', 'the executable compute artifact does not match the registered handler pin')
  }
  handler.artifact.assertIntegrity()
}
