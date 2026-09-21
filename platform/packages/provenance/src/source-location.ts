import { createHash } from 'node:crypto'
import type { ResourceRef, ScopeRef, Sha256Digest, Uuid } from '@ontology/contracts'
import { ProvenanceError } from './errors'

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

/**
 * A locator inside a source document (D3.2). A model-generated title is never a
 * locator: a page or a byte offset plus a quote digest is required, and an
 * imprecise OCR match must set `approximateLocator` so it is reviewed instead of
 * being presented as exact in-page evidence.
 */
export interface SourceLocationInput {
  readonly scopeRef: ScopeRef
  readonly artifactRef: ResourceRef
  readonly documentVersionRef: ResourceRef
  readonly page?: number
  readonly offset?: { readonly start: number; readonly end: number }
  readonly quoteDigest: Sha256Digest
  readonly approximateLocator?: boolean
  readonly normalizationRef?: ResourceRef
}

export interface SourceLocationRecord {
  readonly sourceLocationRef: ResourceRef
  readonly scopeRef: ScopeRef
  readonly artifactRef: ResourceRef
  readonly documentVersionRef: ResourceRef
  readonly page?: number
  readonly offset?: { readonly start: number; readonly end: number }
  readonly quoteDigest: Sha256Digest
  readonly approximateLocator: boolean
  readonly normalizationRef?: ResourceRef
  readonly lineageKey: Sha256Digest
  readonly recordedSeq: string
  readonly recordedAt: string
}

export function isSha256Digest(value: string): boolean {
  return SHA256_DIGEST.test(value)
}

/**
 * Deterministic lineage key for a document body. Two copies of the same bytes
 * (even uploaded separately) derive the same key, so duplicate pages can be
 * recognised as one source lineage without a cross-tenant content probe.
 */
export function lineageKeyOf(contentDigest: Sha256Digest): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update(`ontology:source-lineage:${contentDigest}`, 'utf8')
    .digest('hex')}`
}

export function assertSourceLocationInput(input: SourceLocationInput): void {
  if (input.artifactRef.id.length === 0 || input.documentVersionRef.id.length === 0) {
    throw new ProvenanceError(
      'INVALID_SOURCE_LOCATION',
      'artifactRef and documentVersionRef must carry non-empty ids',
    )
  }
  if (!isSha256Digest(input.quoteDigest)) {
    throw new ProvenanceError(
      'INVALID_SOURCE_LOCATION',
      'quoteDigest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
  if (input.page === undefined && input.offset === undefined) {
    throw new ProvenanceError(
      'INVALID_SOURCE_LOCATION',
      'a source location requires a page or a byte offset',
    )
  }
  if (input.page !== undefined && (!Number.isInteger(input.page) || input.page < 1)) {
    throw new ProvenanceError('INVALID_SOURCE_LOCATION', 'page must be a positive integer')
  }
  if (input.offset !== undefined) {
    const { start, end } = input.offset
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      throw new ProvenanceError(
        'INVALID_SOURCE_LOCATION',
        'offset must be a half-open [start, end) range with 0 <= start < end',
      )
    }
  }
}

/** Stable locator key used to make a repeated record idempotent. */
export function locatorKeyOf(input: SourceLocationInput): string {
  const page = input.page === undefined ? '' : `p${input.page}`
  const offset =
    input.offset === undefined ? '' : `o${input.offset.start}-${input.offset.end}`
  return `${page}${offset}`
}

/**
 * Deterministic UUID for a source-location reference so an idempotent replay
 * yields the same reference id instead of a fresh one.
 */
export function sourceLocationId(seed: string): Uuid {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`
}

export function buildSourceLocationRecord(
  input: SourceLocationInput,
  lineageKey: Sha256Digest,
  recordedSeq: string,
  recordedAt: string,
): SourceLocationRecord {
  return {
    sourceLocationRef: {
      id: sourceLocationId(
        [
          input.scopeRef.tenantId,
          input.scopeRef.spaceId,
          input.documentVersionRef.id,
          input.artifactRef.id,
          locatorKeyOf(input),
          input.quoteDigest,
        ].join('|'),
      ),
      version: '1.0.0',
      digest: input.quoteDigest,
      kind: 'artifact',
    },
    scopeRef: input.scopeRef,
    artifactRef: input.artifactRef,
    documentVersionRef: input.documentVersionRef,
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(input.offset === undefined ? {} : { offset: { ...input.offset } }),
    quoteDigest: input.quoteDigest,
    approximateLocator: input.approximateLocator ?? false,
    ...(input.normalizationRef === undefined ? {} : { normalizationRef: input.normalizationRef }),
    lineageKey,
    recordedSeq,
    recordedAt,
  }
}
