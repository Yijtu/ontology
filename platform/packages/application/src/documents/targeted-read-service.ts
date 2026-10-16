import {
  DocumentTargetedReadError,
  assertDocumentTargetedReadRequestShape,
  assertDocumentTargetedReadResultShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  DocumentTargetedReadRequest,
  DocumentTargetedReadResult,
  DocumentTargetedReaderPort,
  ToolContext,
} from '@ontology/contracts'

export interface DocumentTargetedReadServiceDependencies {
  /** The versioned targeted-read capability, implemented by an adapter over the parse/span store. */
  readonly reader: DocumentTargetedReaderPort
}

/**
 * The `document_search` versioned targeted-read mode (design §6).
 *
 * It validates the untrusted request and the returned result at the boundary, refuses a request
 * without a host-minted trusted context, and delegates to the reader. The service never lets a
 * caller bypass the byte cap, the page bound or the per-item version/locator/digest binding: those
 * are enforced by the request shape and the reader, and both are re-checked here.
 */
export class DocumentTargetedReadService {
  readonly #reader: DocumentTargetedReaderPort

  constructor(dependencies: DocumentTargetedReadServiceDependencies) {
    this.#reader = dependencies.reader
  }

  async read(request: DocumentTargetedReadRequest, ctx: ToolContext): Promise<DocumentTargetedReadResult> {
    if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
      throw new DocumentTargetedReadError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
    }
    assertDocumentTargetedReadRequestShape(request)
    const result = await this.#reader.read(request, ctx)
    assertDocumentTargetedReadResultShape(result)
    return result
  }
}
