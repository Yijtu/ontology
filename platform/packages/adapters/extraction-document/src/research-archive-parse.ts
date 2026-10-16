import { isToolContext } from '@ontology/contracts'
import type {
  DocumentParserPort,
  ResearchArchiveParsePort,
  ResearchArchivedDocumentBinding,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { DocumentExtractionError } from './errors'

export interface ResearchArchiveParserDependencies {
  /** The real document parser; a research archive is parsed through the same facilities as uploads. */
  readonly parser: DocumentParserPort
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DocumentExtractionError('SCOPE_MISMATCH', 'a host-minted trusted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Bridges an archived web page into the existing document pipeline (design §6).
 *
 * A page archived by `web_search` is raw bytes plus derived text, not a `DocumentParseRecord`. This
 * adapter parses the archived original through the same `DocumentParserPort` used for uploads, so
 * a research archive becomes a readable, span-locatable document whose parse/chunks can be read by
 * the targeted reader — no second parsing implementation, and never a fake snapshot.
 */
export class ResearchArchiveParser implements ResearchArchiveParsePort {
  readonly #parser: DocumentParserPort

  constructor(dependencies: ResearchArchiveParserDependencies) {
    this.#parser = dependencies.parser
  }

  async parseArchivedPage(
    input: {
      readonly documentRef: ResourceRef
      readonly provenanceRef: ResourceRef
      readonly contentForm?: string
    },
    ctx: ToolContext,
  ): Promise<ResearchArchivedDocumentBinding> {
    const scope = scopeOf(ctx)
    const parsed = await this.#parser.parse({ scopeRef: scope, originalRef: input.documentRef }, ctx)
    return {
      documentRef: parsed.originalRef,
      parseId: parsed.parseId,
      parserVersion: parsed.parserVersion,
      parseRef: parsed.spanMapRef,
      normalizedRef: parsed.normalizedRef,
    }
  }
}
