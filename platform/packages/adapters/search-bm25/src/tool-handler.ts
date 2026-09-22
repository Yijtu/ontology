import type { DocumentSearchOutput, ToolContext, ToolCoverage } from '@ontology/contracts'
import { parseDocumentSearchRequest } from './parse'
import type { Bm25DocumentSearchService } from './service'
import type {
  DocumentSearchToolHandler,
  DocumentSearchToolOutcome,
  DocumentSearchToolRequest,
  DocumentSearchToolSourceObservation,
  DocumentSearchToolWarning,
} from './types'

export interface Bm25DocumentSearchToolDependencies {
  readonly service: Bm25DocumentSearchService
  /**
   * The host-minted trusted context for the run this handler serves. The gateway
   * binds a gateway to one run but passes no context to a handler, so the handler
   * is bound to the run's context at composition time (like the gateway is bound
   * to the run's ledger and profile). It is never taken from model input.
   */
  readonly ctx: ToolContext
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
      const detail = await dependencies.service.searchDetailed(parsed, dependencies.ctx)
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
