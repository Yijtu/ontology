import {
  ControlPostgresRepository,
  PostgresIdentityDecisionStore,
  PostgresSemanticDefinitionStore,
  PostgresSemanticPublicationStore,
  type ControlPostgresDatabase,
} from '@ontology/adapter-control-postgres'
import type { SourceRef, VersionRef } from '@ontology/contracts'
import { OntologyLookupService, PublishedFactReferenceProvider, SemanticDefinitionService } from '@ontology/semantic-engine'
import { OntologyLookupHandler } from '@ontology/tool-services'

/** Deployment-only composition; the shared gateway sees the ordinary ontology_lookup tool. */
export function createPublishedOntologyCapability(input: {
  readonly database: ControlPostgresDatabase
  readonly namespace: string
  readonly definitionRef: VersionRef
  readonly allowedConceptIds: readonly string[]
}): { readonly lookup: OntologyLookupService; readonly handler: OntologyLookupHandler; readonly sourceRef: SourceRef } {
  const definitions = new SemanticDefinitionService({
    control: new ControlPostgresRepository(input.database),
    store: new PostgresSemanticDefinitionStore(input.database),
  })
  const facts = new PublishedFactReferenceProvider({
    publications: new PostgresSemanticPublicationStore(input.database),
    identity: new PostgresIdentityDecisionStore(input.database),
    namespace: input.namespace,
    definitionRef: input.definitionRef,
    allowedConceptIds: input.allowedConceptIds,
  })
  const lookup = new OntologyLookupService({ definitions, facts, pageSize: 50, maxPageSize: 200 })
  const sourceRef: SourceRef = { namespace: 'ontology.published', sourceId: input.definitionRef.id }
  return { lookup, handler: new OntologyLookupHandler({ lookup, sourceRef }), sourceRef }
}
