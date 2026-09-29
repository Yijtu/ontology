import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import {
  PostgresEvidenceStore,
  PostgresMaterializationStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { ProvenanceReadService } from '@ontology/provenance'
import { HistoryReadService, MaterializedRuleSupportReader, SupportEvidenceDependencySource } from '@ontology/semantic-engine'

/**
 * Composition root for the on-demand provenance/history read side (SPEC C6, US-017/US-022).
 *
 * The provenance and semantic-engine services import only contracts; the concrete
 * PostgreSQL evidence/publication stores and the content-addressed blob store are wired here.
 * The dependency source is built from the official published read view, so a type relation in
 * the ontology definitions can never be mistaken for an evidence dependency.
 */
export interface ProvenanceReadCompositionOptions {
  readonly database: ControlPostgresDatabase
  readonly blobStore: LocalImmutableBlobStore
  readonly maxDependencyDepth?: number
  readonly maxPageSize?: number
}

export interface ProvenanceReadComposition {
  readonly provenance: ProvenanceReadService
  readonly history: HistoryReadService
  readonly evidence: PostgresEvidenceStore
  readonly publication: PostgresSemanticPublicationStore
}

export function createPostgresProvenanceRead(
  options: ProvenanceReadCompositionOptions,
): ProvenanceReadComposition {
  const evidence = new PostgresEvidenceStore(options.database)
  const publication = new PostgresSemanticPublicationStore(options.database)
  const materialization = new PostgresMaterializationStore(options.database)
  const supportReader = new MaterializedRuleSupportReader({
    materialization,
    evidence,
    payloadMetadataReader: options.blobStore,
    payloadReader: options.blobStore,
  })
  const dependencies = new SupportEvidenceDependencySource({ published: publication, supportReader })
  const provenance = new ProvenanceReadService({
    evidence,
    blobs: options.blobStore,
    dependencies,
    reader: options.blobStore,
    ...(options.maxDependencyDepth === undefined
      ? {}
      : { maxDependencyDepth: options.maxDependencyDepth }),
    ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
  })
  const history = new HistoryReadService({
    store: publication,
    ...(options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize }),
  })
  return { provenance, history, evidence, publication }
}
