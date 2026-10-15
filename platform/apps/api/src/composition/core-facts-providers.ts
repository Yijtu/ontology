import { PublishedFactsReferenceProvider } from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  OntologyFactPage,
  OntologyFactQuery,
  OntologyFactReferenceProvider,
  PublishedSemanticData,
} from '@ontology/semantic-engine'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { CoreFactsPlanError, createCoreFactsPlan } from './core-facts-plan'
import { CoreFactsRequestError } from './core-errors'

/** The Core published-facts reference provider and the multi-scenario published source. */

export class CorePublishedFactsProvider implements OntologyFactReferenceProvider {
  readonly #providers: ReadonlyMap<string, PublishedFactsReferenceProvider>

  constructor(providers: readonly { readonly namespace: string; readonly provider: PublishedFactsReferenceProvider }[]) {
    this.#providers = new Map(providers.map((entry) => [entry.namespace, entry.provider]))
  }

  async listFacts(query: OntologyFactQuery, ctx: ToolContext): Promise<OntologyFactPage> {
    const namespaces = [...new Set(query.concepts.map((concept) => concept.namespace))]
    if (namespaces.length !== 1) return { facts: [], nextCursor: null, covered: false, issues: ['one exact deployment namespace is required'] }
    const provider = this.#providers.get(namespaces[0] ?? '')
    if (provider === undefined) return { facts: [], nextCursor: null, covered: false, issues: ['the requested namespace has no published facts provider'] }
    return provider.listFacts(query, ctx)
  }
}

export class CoreMultiSchemaPublishedSource implements MaterializationPublishedSource {
  readonly #sources: readonly MaterializationPublishedSource[]

  constructor(sources: readonly MaterializationPublishedSource[]) {
    this.#sources = sources
  }

  async load(scopeRef: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const parts = await Promise.all(this.#sources.map((source) => source.load(scopeRef, ctx)))
    const firstRevision = parts[0]?.readRevision
    const sameRevision = firstRevision !== undefined && parts.every((part) =>
      part.readRevision?.semantic === firstRevision.semantic && part.readRevision.identity === firstRevision.identity,
    )
    const issues = parts.flatMap((part) => part.issues ?? [])
    if (!sameRevision) issues.push({ code: 'READ_REVISION_CHANGED', message: 'scenario snapshots did not share one semantic and identity revision vector' })
    return {
      partitions: parts,
      facts: parts.flatMap((part) => part.facts),
      rules: parts.flatMap((part) => part.rules),
      entityBindings: parts.flatMap((part) => part.entityBindings),
      ...(sameRevision && firstRevision !== undefined ? { readRevision: firstRevision } : {}),
      historicalAsOfSupported: false,
      complete: sameRevision && parts.every((part) => part.complete === true),
      ...(parts.some((part) => part.identityBindings !== undefined)
        ? { identityBindings: parts.flatMap((part) => part.identityBindings ?? []) }
        : {}),
      ...(parts.some((part) => part.ruleIssues !== undefined)
        ? { ruleIssues: parts.flatMap((part) => part.ruleIssues ?? []) }
        : {}),
      ...(parts.some((part) => part.attributeIssues !== undefined)
        ? { attributeIssues: parts.flatMap((part) => part.attributeIssues ?? []) }
        : {}),
      ...(issues.length > 0 ? { issues } : {}),
    }
  }
}

export function validateCoreFactsRequest(input: Parameters<typeof createCoreFactsPlan>[0]): void {
  try {
    createCoreFactsPlan(input)
  } catch (error) {
    if (error instanceof CoreFactsPlanError) throw new CoreFactsRequestError(error)
    throw error
  }
}
