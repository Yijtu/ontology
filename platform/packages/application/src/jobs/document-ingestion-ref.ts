import type { ResourceRef, Semver, VersionRef } from '@ontology/contracts'
import { tryParseSemver } from '@ontology/contracts'
import { JobStageFailure } from './errors'

/**
 * The ingestion reference an ingestion job carries in its opaque `documentRef` while it is at
 * the `received` stage.
 *
 * The durable job record stores only string references, so the ingestion/publication path
 * (LOCAL-031) pins the immutable original, the parser version and the published industry
 * definition here. The `received → parsed` stage decodes it, runs the real parser and rewrites
 * the job's `documentRef` into the structured `ExtractionJobRef` (parse id + parser version +
 * definition + optional document version) that the `parsed → extracted` stage already consumes.
 *
 * The reference is JSON and every field is validated on decode (never trusted as a type
 * assertion), because the job body crosses the wire boundary.
 */
export interface DocumentIngestionRef {
  readonly kind: 'document_ingestion'
  /** The immutable original document in blob-local. Never rewritten by parsing. */
  readonly originalRef: ResourceRef
  readonly parserVersion: Semver
  readonly definitionRef: VersionRef
  readonly documentVersionRef?: ResourceRef
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      `ingestion reference field "${field}" must be a non-empty string`,
      false,
    )
  }
  return value
}

function decodeVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      `ingestion reference field "${field}" must be an object`,
      false,
    )
  }
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
  }
}

function decodeResourceRef(value: unknown, field: string): ResourceRef {
  if (!isRecord(value)) {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      `ingestion reference field "${field}" must be an object`,
      false,
    )
  }
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
    kind: requireString(value['kind'], `${field}.kind`) as ResourceRef['kind'],
  }
}

/** Encode the ingestion reference into the job's opaque `documentRef` string. */
export function encodeDocumentIngestionRef(ref: DocumentIngestionRef): string {
  return JSON.stringify(ref)
}

/**
 * Decode and validate the job's `documentRef` at the `received` stage. A malformed reference
 * fails the stage explicitly instead of producing a parse of the wrong document.
 */
export function decodeDocumentIngestionRef(documentRef: string): DocumentIngestionRef {
  let parsed: unknown
  try {
    parsed = JSON.parse(documentRef)
  } catch (error) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the ingestion reference is not valid JSON', false, {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the ingestion reference must be a JSON object', false)
  }
  if (parsed['kind'] !== 'document_ingestion') {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      'the ingestion reference kind must be document_ingestion',
      false,
    )
  }
  const parserVersion = requireString(parsed['parserVersion'], 'parserVersion')
  if (tryParseSemver(parserVersion) === undefined) {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      'ingestion reference field "parserVersion" must be a semver string',
      false,
    )
  }
  const documentVersionRef = parsed['documentVersionRef']
  return {
    kind: 'document_ingestion',
    originalRef: decodeResourceRef(parsed['originalRef'], 'originalRef'),
    parserVersion,
    definitionRef: decodeVersionRef(parsed['definitionRef'], 'definitionRef'),
    ...(documentVersionRef === undefined
      ? {}
      : { documentVersionRef: decodeResourceRef(documentVersionRef, 'documentVersionRef') }),
  }
}
