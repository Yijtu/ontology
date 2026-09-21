import type { OffsetUnit } from '@ontology/contracts'
import { DocumentExtractionError } from './errors'

/**
 * The normalized text is wrapped in a small envelope so the derived artifact is
 * never byte-identical to a user upload (the blob registry keys content by
 * digest alone, so identical bytes with a different media type would conflict).
 * `offsetUnit` travels with the text so a reader slices it correctly.
 */
export const NORMALIZED_TEXT_MEDIA_TYPE = 'application/vnd.ontology.normalized-text+json'

export interface NormalizedTextArtifact {
  readonly schemaVersion: '1.0.0'
  readonly offsetUnit: OffsetUnit
  readonly text: string
}

export function buildNormalizedTextArtifact(offsetUnit: OffsetUnit, text: string): Uint8Array {
  const artifact: NormalizedTextArtifact = { schemaVersion: '1.0.0', offsetUnit, text }
  return new TextEncoder().encode(JSON.stringify(artifact))
}

export function parseNormalizedTextArtifact(bytes: Uint8Array): NormalizedTextArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  } catch (error) {
    throw new DocumentExtractionError(
      'SPAN_STORE_FAILED',
      'the stored normalized-text artifact is not valid JSON',
      { cause: error },
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the normalized-text artifact is malformed')
  }
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== '1.0.0' || typeof record.text !== 'string') {
    throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the normalized-text artifact is malformed')
  }
  if (record.offsetUnit !== 'byte' && record.offsetUnit !== 'character') {
    throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the normalized-text artifact is malformed')
  }
  return { schemaVersion: '1.0.0', offsetUnit: record.offsetUnit, text: record.text }
}
