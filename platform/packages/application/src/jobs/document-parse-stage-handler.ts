import type {
  DocumentParserPort,
  ErrorCode,
  JobStageCounts,
  ParseCoverage,
  ParsedDocument,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { encodeExtractionJobRef } from '../extraction/job-ref'
import type { ExtractionJobRef } from '../extraction/types'
import { decodeDocumentIngestionRef } from './document-ingestion-ref'
import { JobStageFailure } from './errors'
import type { JobStageContext, JobStageHandler, JobStageOutcome } from './types'

/**
 * Maps a classified parser failure onto the canonical error catalogue without importing the
 * adapter (application → adapter is forbidden). The adapter's `DocumentExtractionError` carries
 * a string `code`; only known codes are honoured, everything else is an internal error. The
 * message is fixed per code, so a raw parser message — which may quote the document — is never
 * persisted into the job record.
 */
const PARSE_FAILURE_CODES: Readonly<Record<string, { readonly code: ErrorCode; readonly message: string }>> = {
  INVALID_REQUEST: { code: 'INVALID_ARGUMENT', message: 'the document parse request was rejected' },
  SCOPE_MISMATCH: { code: 'INVALID_ARGUMENT', message: 'the document parse scope was rejected' },
  UNSUPPORTED_MEDIA_TYPE: {
    code: 'INVALID_ARGUMENT',
    message: 'no parser is registered for the document media type',
  },
  ORIGINAL_UNREADABLE: {
    code: 'SOURCE_UNAVAILABLE',
    message: 'the immutable original could not be read',
  },
  DOCUMENT_PARSE_FAILED: {
    code: 'SOURCE_UNAVAILABLE',
    message: 'the document could not be parsed',
  },
  DOCUMENT_NOT_PARSED: {
    code: 'SOURCE_UNAVAILABLE',
    message: 'no parse of the immutable original is available',
  },
  OCR_UNAVAILABLE: {
    code: 'SOURCE_UNAVAILABLE',
    message: 'the document needs OCR but no provider is configured',
  },
  SPAN_OUT_OF_RANGE: {
    code: 'EVIDENCE_PERSIST_FAILED',
    message: 'a chunk span fell outside the original document',
  },
  SPAN_STORE_FAILED: {
    code: 'EVIDENCE_PERSIST_FAILED',
    message: 'the parse result could not be persisted',
  },
}

/** Failure codes a retry may resolve: a transient read/write or a missing parse, not bad bytes. */
const RETRYABLE_PARSE_FAILURE_CODES: readonly string[] = [
  'ORIGINAL_UNREADABLE',
  'DOCUMENT_NOT_PARSED',
  'SPAN_STORE_FAILED',
]

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function toParseFailure(error: unknown): JobStageFailure {
  const code = errorCodeOf(error)
  if (code === undefined) {
    return new JobStageFailure('INTERNAL_ERROR', 'the document parser failed', false, { cause: error })
  }
  const descriptor = PARSE_FAILURE_CODES[code]
  if (descriptor === undefined) {
    return new JobStageFailure('INTERNAL_ERROR', 'the document parser failed', false, { cause: error })
  }
  const retryable = RETRYABLE_PARSE_FAILURE_CODES.includes(code)
  return new JobStageFailure(descriptor.code, descriptor.message, retryable, { cause: error })
}

/** `processed` is what the parser captured; `skipped` is what it explicitly did not. */
function countsFromCoverage(coverage: ParseCoverage): JobStageCounts {
  return {
    total: coverage.totalUnits,
    processed: coverage.parsedUnits,
    failed: 0,
    skipped: coverage.skippedUnits,
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

export interface DocumentParseStageHandlerDependencies {
  /** The real parser (LOCAL-023). It archives the original/normalised artifacts and spans. */
  readonly parser: DocumentParserPort
}

/**
 * `received → parsed` (SPEC D3/D6). The one stage that turns a stored original document into a
 * durable, traceable parse: it invokes the injected `DocumentParserPort`, which persists the
 * parse run, the chunks/spans and the content-addressed normalized-text and span-map artifacts,
 * then reports the coverage counts and rewrites the job's `documentRef` into the structured
 * `ExtractionJobRef` that `parsed → extracted` already consumes.
 *
 * The handler owns no persistence of its own: the worker commits the counts, the new
 * `documentRef` and the stage checkpoint in one transaction. Because the parser is
 * content-addressed and idempotent, a crash after archiving but before that checkpoint leaves
 * no duplicate artifact or span; the reclaimed attempt converges on the same parse.
 */
export class DocumentParseStageHandler implements JobStageHandler {
  readonly stage = 'received' as const
  readonly #parser: DocumentParserPort

  constructor(dependencies: DocumentParseStageHandlerDependencies) {
    this.#parser = dependencies.parser
  }

  async run(context: JobStageContext): Promise<JobStageOutcome> {
    const documentRef = context.job.documentRef
    if (documentRef === undefined) {
      throw new JobStageFailure('INVALID_ARGUMENT', 'an ingestion job requires a documentRef', false)
    }
    const ingestionRef = decodeDocumentIngestionRef(documentRef)

    let parsed: ParsedDocument
    try {
      parsed = await this.#parser.parse(
        {
          scopeRef: scopeOf(context.ctx),
          originalRef: ingestionRef.originalRef,
          parserVersion: ingestionRef.parserVersion,
          ...(ingestionRef.documentVersionRef === undefined
            ? {}
            : { documentVersionRef: ingestionRef.documentVersionRef }),
        },
        context.ctx,
      )
    } catch (error) {
      throw toParseFailure(error)
    }

    const extractionRef: ExtractionJobRef = {
      parseId: parsed.parseId,
      parserVersion: parsed.parserVersion,
      definitionRef: ingestionRef.definitionRef,
      ...(ingestionRef.documentVersionRef === undefined
        ? {}
        : { documentVersionRef: ingestionRef.documentVersionRef }),
      // The parser's real truncation lineage travels with the checkpoint, so a downstream stage
      // never treats a truncated chunk as complete evidence (SPEC D4.1/D4.3, INV-06).
      truncatedChunkIds: parsed.truncatedChunkIds,
    }
    return {
      nextStage: 'parsed',
      counts: countsFromCoverage(parsed.coverage),
      documentRef: encodeExtractionJobRef(extractionRef),
    }
  }
}
