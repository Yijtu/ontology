import type { JobKind, RunnableJobStage, Semver } from '@ontology/contracts'
import { tryParseSemver } from '@ontology/contracts'
import { JobServiceError } from './errors'

export interface ParsedCreateJobRequest {
  readonly kind: JobKind
  readonly sourceRef: string
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly pipelineVersion: Semver
}

export interface ParsedRetryJobRequest {
  readonly failedStage: RunnableJobStage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JobServiceError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function isJobKind(value: unknown): value is JobKind {
  return value === 'ingestion' || value === 'simulation'
}

function isRunnableStage(value: unknown): value is RunnableJobStage {
  return value === 'received' || value === 'parsed' || value === 'extracted' || value === 'validated'
}

/**
 * Validate the untrusted `POST /ingestions` body and narrow it to typed fields. It accepts
 * `unknown` and performs every check explicitly, so neither the HTTP layer nor the service
 * needs a type assertion to cross the wire boundary. Identity, budget and the tool allowlist
 * are intentionally absent: they are established by the server, never by the request body.
 */
export function parseCreateJobRequest(body: unknown): ParsedCreateJobRequest {
  if (!isRecord(body)) {
    throw new JobServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
  }
  const kind = body['kind'] ?? 'ingestion'
  if (!isJobKind(kind)) {
    throw new JobServiceError('INVALID_ARGUMENT', 'kind must be ingestion or simulation')
  }
  const sourceRef = requireNonEmptyString(body['sourceRef'], 'sourceRef')
  const pipelineVersion = requireNonEmptyString(body['pipelineVersion'], 'pipelineVersion')
  if (tryParseSemver(pipelineVersion) === undefined) {
    throw new JobServiceError('INVALID_ARGUMENT', 'pipelineVersion must be a semver string')
  }
  const documentRef = body['documentRef']
  const datasetRef = body['datasetRef']
  const parsedDocumentRef =
    documentRef === undefined ? undefined : requireNonEmptyString(documentRef, 'documentRef')
  const parsedDatasetRef =
    datasetRef === undefined ? undefined : requireNonEmptyString(datasetRef, 'datasetRef')
  if (parsedDocumentRef === undefined && parsedDatasetRef === undefined) {
    throw new JobServiceError(
      'INVALID_ARGUMENT',
      'one of documentRef or datasetRef must be a non-empty string',
    )
  }
  return {
    kind,
    sourceRef,
    ...(parsedDocumentRef === undefined ? {} : { documentRef: parsedDocumentRef }),
    ...(parsedDatasetRef === undefined ? {} : { datasetRef: parsedDatasetRef }),
    pipelineVersion,
  }
}

export function parseRetryJobRequest(body: unknown): ParsedRetryJobRequest {
  if (!isRecord(body)) {
    throw new JobServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
  }
  const failedStage = body['failedStage']
  if (!isRunnableStage(failedStage)) {
    throw new JobServiceError(
      'INVALID_ARGUMENT',
      'failedStage must be received, parsed, extracted or validated',
    )
  }
  return { failedStage }
}
