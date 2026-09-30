import type { DataMode, DocumentSpanReaderPort } from '@ontology/contracts'
import { parseDocumentSearchRequest } from '@ontology/adapter-search-bm25'
import type { Bm25DocumentSearchService } from '@ontology/adapter-search-bm25'
import type { ToolExecutionOutcome, ToolHandler, ToolSourceObservation } from '@ontology/tool-services'

/**
 * The Core `document_search` handler (SPEC v0.3a §7, V03-019/V03-020).
 *
 * The BM25 backend returns ranked spans (document ref, locator, quote digest) but not the span
 * text. A document-QA answer must cite the *exact* archived quote, so this handler resolves each
 * returned span through the same LOCAL-023 span reader the index was built from and attaches the
 * byte-exact text plus its digest. The citation the typed draft writer emits is then fully
 * re-readable: the quote, its digest, the document ref and the locator all resolve to one
 * immutable span, so an approximate or missing quote can never satisfy the verifier.
 *
 * A span whose bounded citation read is truncated is not cited (it would not match its quoted
 * digest); it is surfaced as an explicit warning instead of silently dropped.
 */

const MAX_CITATION_SPAN_BYTES = 16 * 1024

export interface CoreDocumentSearchHandlerDependencies {
  readonly service: Bm25DocumentSearchService
  readonly spanReader: DocumentSpanReaderPort
  readonly dataMode?: DataMode
}

interface CitationSpan {
  readonly documentRef: unknown
  readonly locator: unknown
  readonly quoteDigest: string
  readonly textDigest: string
  readonly spanKind: unknown
  readonly quote: string
  readonly subject: string
  readonly score?: number
}

export function createCoreDocumentSearchHandler(
  dependencies: CoreDocumentSearchHandlerDependencies,
): ToolHandler {
  return {
    toolId: 'document_search',
    async execute(request): Promise<ToolExecutionOutcome> {
      const parsed = parseDocumentSearchRequest(request.arguments)
      const detail = await dependencies.service.searchDetailed(parsed, request.ctx)
      const spans: CitationSpan[] = []
      const warnings: { code: string; message: string }[] = []
      for (const span of detail.response.spans) {
        const read = await dependencies.spanReader.readSpan(
          { documentRef: span.documentRef, locator: span.locator, maxBytes: MAX_CITATION_SPAN_BYTES },
          request.ctx,
        )
        if (read.truncated === true) {
          warnings.push({
            code: 'CITATION_SPAN_TRUNCATED',
            message: `span ${span.documentRef.id} exceeded the bounded citation read and cannot be quoted exactly`,
          })
          continue
        }
        spans.push({
          documentRef: span.documentRef,
          locator: span.locator,
          quoteDigest: span.quoteDigest,
          textDigest: read.textDigest,
          spanKind: span.spanKind,
          quote: read.text,
          subject: span.documentRef.id,
          ...(span.score === undefined ? {} : { score: span.score }),
        })
      }
      const snapshot = detail.response.snapshot
      const source: ToolSourceObservation = {
        sourceRef: snapshot.sourceRef,
        schemaVersion: snapshot.schemaVersion,
        consistency: snapshot.consistency,
        resultDigest: snapshot.resultDigest,
      }
      const returned = spans.length
      const status: ToolExecutionOutcome['status'] = returned === 0 ? 'empty' : detail.truncated ? 'partial' : 'ok'
      return {
        payload: {
          spans,
          scoreKind: detail.response.scoreKind,
          indexVersion: detail.response.indexVersion,
          completeness: detail.response.completeness,
        },
        status,
        coverage: {
          returned,
          knownTotal: detail.matchedTotal,
          truncated: detail.truncated,
          completeness: detail.response.completeness,
        },
        sources: [source],
        ...(dependencies.dataMode === undefined ? {} : { dataMode: dependencies.dataMode }),
        ...(warnings.length === 0 ? {} : { warnings }),
      }
    },
  }
}
