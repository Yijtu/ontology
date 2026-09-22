import type { DocumentSearchOutput, ToolCoverage } from '@ontology/contracts'
import { DocumentSearchError } from './errors'
import { parseDocumentSearchRequest } from './parse'
import type { Bm25DocumentSearchService } from './service'
import type {
  DocumentSearchDetail,
  DocumentSearchToolHandler,
  DocumentSearchToolOutcome,
  DocumentSearchToolRequest,
  DocumentSearchToolSourceObservation,
  DocumentSearchToolWarning,
} from './types'

export interface Bm25DocumentSearchToolDependencies {
  readonly service: Bm25DocumentSearchService
}

/**
 * Stop waiting for the search as soon as the propagated signal aborts. The keyword
 * index is an in-process read, so the handler cannot confirm a remote interrupt; it
 * reports the catalogue's `DEADLINE_EXCEEDED` (remote state unknown) so the gateway
 * settles the reservation conservatively instead of returning a traceable success.
 */
function raceWithSignal(
  work: Promise<DocumentSearchDetail>,
  signal: AbortSignal,
): Promise<DocumentSearchDetail> {
  const cancelled = (): DocumentSearchError =>
    new DocumentSearchError('DEADLINE_EXCEEDED', 'the document search was cancelled')
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<DocumentSearchDetail>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The real `document_search` tool handler (C4). It wraps the `DocumentSearchPort`
 * and produces the unified tool outcome: the `DocumentSearchOutput` payload plus
 * an honest `ToolCoverage`.
 *
 * Coverage semantics (C4, D7.3): `knownTotal` is the recall-range size for this
 * query, not the size of the corpus, and `truncated` only reports page truncation.
 * A miss over the recall range therefore never encodes "the corpus does not
 * contain it", and a zero-result success carries an explicit warning so a caller
 * cannot read absence into a keyword miss.
 */
export function createBm25DocumentSearchToolHandler(
  dependencies: Bm25DocumentSearchToolDependencies,
): DocumentSearchToolHandler {
  return {
    toolId: 'document_search',
    async execute(request: DocumentSearchToolRequest): Promise<DocumentSearchToolOutcome> {
      const parsed = parseDocumentSearchRequest(request.arguments)
      const detail = await raceWithSignal(
        dependencies.service.searchDetailed(parsed, request.ctx),
        request.signal,
      )
      const spans = detail.response.spans
      const coverage: ToolCoverage = {
        returned: spans.length,
        knownTotal: detail.matchedTotal,
        truncated: detail.truncated,
        completeness: detail.response.completeness,
      }
      const payload: DocumentSearchOutput = {
        spans,
        scoreKind: detail.response.scoreKind,
        indexVersion: detail.response.indexVersion,
        completeness: detail.response.completeness,
      }
      const source: DocumentSearchToolSourceObservation = {
        sourceRef: detail.response.snapshot.sourceRef,
        schemaVersion: detail.response.snapshot.schemaVersion,
        consistency: detail.response.snapshot.consistency,
        resultDigest: detail.response.snapshot.resultDigest,
      }
      const warnings: DocumentSearchToolWarning[] = []
      if (spans.length === 0) {
        warnings.push({
          code: 'KEYWORD_MISS_IS_NOT_ABSENCE',
          message:
            'no indexed keyword matched; a top-k miss over the recall range does not prove the corpus lacks the information',
        })
      }
      if (detail.duplicatesCollapsed > 0) {
        warnings.push({
          code: 'DUPLICATE_SOURCES_COLLAPSED',
          message: `${String(detail.duplicatesCollapsed)} duplicate source span(s) were collapsed and are not independent evidence`,
        })
      }
      const status = spans.length === 0 ? 'empty' : detail.truncated ? 'partial' : 'ok'
      return { payload, status, coverage, sources: [source], warnings }
    },
  }
}
