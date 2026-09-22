import { createBm25DocumentSearchToolHandler } from '@ontology/adapter-search-bm25'
import type { Bm25DocumentSearchService } from '@ontology/adapter-search-bm25'
import type {
  CatalogPort,
  ConsistencyLevel,
  ResolvedProfile,
  SourceRef,
  StructuredQueryPort,
  WebSearchProvider,
} from '@ontology/contracts'
import type { OntologyLookupService, SemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler, OntologyLookupHandler, WebSearchHandler } from '@ontology/tool-services'
import type { DataQueryComputeConfig, ToolHandler } from '@ontology/tool-services'

/**
 * The tool-handler assembly for a deployment (C4, LOCAL-059).
 *
 * It constructs the four registered handlers from injected ports only. It deliberately
 * takes **no** `ToolContext`: the run's trusted context is minted by the assembly/HTTP
 * layer and injected by the gateway on the `execute` path, so a handler can never capture
 * a run identity at construction time and cannot run without the context the gateway
 * passes it.
 */
export interface ToolHandlerSetOptions {
  readonly query: StructuredQueryPort
  readonly catalog?: CatalogPort
  readonly mappings: SemanticMappingRegistry
  /** Absent means `ontology_lookup` is not wired for this deployment. */
  readonly lookup?: {
    readonly service: OntologyLookupService
    /** The control/semantic store `ontology_lookup` reads from; never fabricated. */
    readonly sourceRef: SourceRef
  }
  readonly documentSearch: Bm25DocumentSearchService
  /** Absent means `web_search` is explicitly not configured for this deployment. */
  readonly webSearch?: WebSearchProvider
  readonly allowWeb: boolean
  readonly resolvedProfile: ResolvedProfile
  /** The registered public-web source `web_search` reads; used for the evidence snapshot. */
  readonly webSourceRef: SourceRef
  readonly dataQuery?: {
    readonly maxJoinFanout?: number
    readonly estimatedBytesPerRow?: number
    readonly consistency?: ConsistencyLevel
    readonly catalogSourceRef?: SourceRef
  }
  /** Absent means `data_query.kind=compute` is not configured for this deployment. */
  readonly compute?: DataQueryComputeConfig
}

export function createToolHandlerSet(options: ToolHandlerSetOptions): readonly ToolHandler[] {
  const dataQuery = options.dataQuery ?? {}
  const queryHandler = new DataQueryHandler({
    query: options.query,
    mappings: options.mappings,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(dataQuery.maxJoinFanout === undefined ? {} : { maxJoinFanout: dataQuery.maxJoinFanout }),
    ...(dataQuery.estimatedBytesPerRow === undefined
      ? {}
      : { estimatedBytesPerRow: dataQuery.estimatedBytesPerRow }),
    ...(dataQuery.consistency === undefined ? {} : { consistency: dataQuery.consistency }),
    ...(dataQuery.catalogSourceRef === undefined ? {} : { catalogSourceRef: dataQuery.catalogSourceRef }),
    ...(options.compute === undefined ? {} : { compute: options.compute }),
  })
  const webHandler = new WebSearchHandler({
    ...(options.webSearch === undefined ? {} : { provider: options.webSearch }),
    allowWeb: options.allowWeb,
    resolvedProfile: options.resolvedProfile,
    sourceRef: options.webSourceRef,
  })
  const handlers: ToolHandler[] = []
  if (options.lookup !== undefined) {
    handlers.push(
      new OntologyLookupHandler({
        lookup: options.lookup.service,
        sourceRef: options.lookup.sourceRef,
      }),
    )
  }
  handlers.push(
    queryHandler,
    createBm25DocumentSearchToolHandler({ service: options.documentSearch }),
    webHandler,
  )
  return handlers
}
