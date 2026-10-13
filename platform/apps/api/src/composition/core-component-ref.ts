import { canonicalJson, sha256DigestOf } from '@ontology/core'
import type { ComponentKind, SupportedDataType, VersionRef } from '@ontology/contracts'
import { COMPONENT_VERSION } from './core-constants'

/** Stable component/version keys and the capability declaration a mounted component provides. */

export function componentRef(kind: ComponentKind, id: string, digestSeed: unknown): VersionRef {
  return { id, version: COMPONENT_VERSION, digest: sha256DigestOf(canonicalJson({ kind, id, digestSeed })) }
}

export function capability(name: string) {
  const supportedDataTypes: SupportedDataType[] = ['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json']
  return {
    name,
    version: COMPONENT_VERSION,
    limits: { maxRows: 1_000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 },
    consistency: 'repeatable_read' as const,
    cancellation: 'supported' as const,
    pagination: 'cursor' as const,
    supportedDataTypes,
  }
}
