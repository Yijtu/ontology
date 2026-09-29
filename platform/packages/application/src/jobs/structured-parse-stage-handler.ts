import type {
  ErrorCode,
  JobStageCounts,
  ScopeRef,
  StructuredIngestionPort,
  StructuredRecordCounts,
  ToolContext,
} from '@ontology/contracts'
import { JobStageFailure } from './errors'
import { decodeStructuredIngestionRef, encodeStructuredExtractionRef } from './structured-ingestion-ref'
import type { JobStageContext, JobStageHandler, JobStageOutcome } from './types'

/**
 * Maps a classified structured-ingestion failure onto the canonical error catalogue without
 * importing the adapter (application → adapter is forbidden). The adapter's
 * `StructuredIngestionError` carries a string code and parser diagnostics; only known codes are
 * honoured, and every message is fixed, so raw parser text — which may quote the document — is
 * never persisted into the job record. The diagnostic's row/pointer is kept only as a bounded
 * row number, never as source content (SPEC §8/§10).
 */
const PARSE_REJECTED_MESSAGE = 'the structured parse was rejected'
const FAILURE_DESCRIPTORS: Readonly<Record<string, { code: ErrorCode; message: string; retryable: boolean }>> = {
  INVALID_REQUEST: { code: 'INVALID_ARGUMENT', message: 'the structured parse request was rejected', retryable: false },
  SCOPE_MISMATCH: { code: 'INVALID_ARGUMENT', message: 'the structured parse scope was rejected', retryable: false },
  UNSUPPORTED_MEDIA_TYPE: { code: 'INVALID_ARGUMENT', message: 'no structured parser is registered for the document media type', retryable: false },
  ORIGINAL_UNREADABLE: { code: 'SOURCE_UNAVAILABLE', message: 'the immutable original could not be read', retryable: true },
  PARSE_REJECTED: { code: 'INVALID_ARGUMENT', message: PARSE_REJECTED_MESSAGE, retryable: false },
  PARSE_STORE_FAILED: { code: 'EVIDENCE_PERSIST_FAILED', message: 'the structured parse result could not be persisted', retryable: true },
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The first parser diagnostic, reduced to a safe locator: the enum code and the row number.
 * A JSON pointer is deliberately not included, because it may quote a key from the document.
 */
function firstIssueOf(error: unknown): { readonly code?: string; readonly row?: number } {
  if (typeof error !== 'object' || error === null) return {}
  const issues = (error as { readonly issues?: unknown }).issues
  if (!Array.isArray(issues) || issues.length === 0) return {}
  const first: unknown = issues[0]
  if (typeof first !== 'object' || first === null) return {}
  const code = (first as { readonly code?: unknown }).code
  const row = (first as { readonly row?: unknown }).row
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof row === 'number' && Number.isInteger(row) ? { row } : {}),
  }
}

function rejectionMessage(error: unknown): string {
  const issue = firstIssueOf(error)
  if (issue.code === undefined) return PARSE_REJECTED_MESSAGE
  return issue.row === undefined
    ? `${PARSE_REJECTED_MESSAGE} (${issue.code})`
    : `${PARSE_REJECTED_MESSAGE} (${issue.code} at row ${issue.row})`
}

function toParseFailure(error: unknown): JobStageFailure {
  const code = errorCodeOf(error)
  const descriptor = code === undefined ? undefined : FAILURE_DESCRIPTORS[code]
  if (descriptor === undefined) {
    return new JobStageFailure('INTERNAL_ERROR', 'the structured parser failed', false, { cause: error })
  }
  if (code === 'PARSE_REJECTED') {
    return new JobStageFailure('INVALID_ARGUMENT', rejectionMessage(error), false, { cause: error })
  }
  return new JobStageFailure(descriptor.code, descriptor.message, descriptor.retryable, { cause: error })
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/** Pending units are never counted as processed: `skipped` carries the explicitly unprocessed. */
export function countsFromReconciliation(counts: StructuredRecordCounts): JobStageCounts {
  return {
    total: counts.total,
    processed: counts.succeeded,
    failed: counts.failed,
    skipped: counts.pending + counts.skipped,
  }
}

export interface StructuredDocumentParseStageHandlerDependencies {
  /** The structured ingestion port (V03-005 parser + row persistence). */
  readonly ingestion: StructuredIngestionPort
}

/**
 * `received → parsed` for structured formats (SPEC v0.3 A §5). It decodes the caller's
 * selection, runs the injected structured ingestion port, which persists the parse run and its
 * reconciled rows, then reports the row counts and rewrites the job's `documentRef` into the
 * structured extraction reference. A partial parse keeps its pending count and never becomes a
 * full success; a rejected parse fails the stage with a classified, retryability-aware error.
 */
export class StructuredDocumentParseStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #ingestion: StructuredIngestionPort

  constructor(dependencies: StructuredDocumentParseStageHandlerDependencies) {
    this.#ingestion = dependencies.ingestion
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const documentRef = context.job.documentRef
    if (documentRef === undefined) {
      throw new JobStageFailure('INVALID_ARGUMENT', 'an ingestion job requires a documentRef', false)
    }
    const ref = decodeStructuredIngestionRef(documentRef)

    let result
    try {
      result = await this.#ingestion.parse(
        {
          scopeRef: scopeOf(context.ctx),
          originalRef: ref.originalRef,
          options: ref.options,
          parserVersion: ref.parserVersion,
          ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
        },
        context.ctx,
      )
    } catch (error) {
      throw toParseFailure(error)
    }

    // The stored original's media type decides the format; a caller that declared a different
    // one is refused instead of silently parsing the wrong shape as their chosen format.
    if (ref.format !== result.parse.format) {
      throw new JobStageFailure(
        'INVALID_ARGUMENT',
        'the declared structured format does not match the stored original',
        false,
      )
    }

    return {
      nextStage: 'parsed',
      counts: countsFromReconciliation(result.parse.counts),
      documentRef: encodeStructuredExtractionRef({
        kind: 'structured_extraction',
        parseId: result.parse.parseId,
        parserVersion: result.parse.parserVersion,
        definitionRef: ref.definitionRef,
        format: result.parse.format,
        ...(ref.documentVersionRef === undefined ? {} : { documentVersionRef: ref.documentVersionRef }),
      }),
    }
  }
}
