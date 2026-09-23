import {
  PostgresCandidateStore,
  PostgresIdentityDecisionStore,
  PostgresIdentityRecallAuditStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
  type ControlPostgresDatabase,
} from '@ontology/adapter-control-postgres'
import { JobService } from '@ontology/application'
import type { BudgetLedgerPort, SemanticDefinitionVersion } from '@ontology/contracts'
import { EntityCandidateRecallService, IdentityDecisionService, SemanticPublicationService, StructuredIdentityIndexReader } from '@ontology/semantic-engine'
import { LocalDocumentCapability } from './local-documents'
import type { LocalOperatorSqlProfile } from './registered-operator-sql'
import { LocalNativeCandidateIngestion } from './local-native-candidates'
import { PostgresIndustrySchemaSource } from './operator-definition'

export interface LocalCandidateLifecycle {
  readonly candidates: PostgresCandidateStore
  readonly decisions: IdentityDecisionService
  readonly publications: SemanticPublicationService
  readonly recall: EntityCandidateRecallService
  readonly recallAudits: PostgresIdentityRecallAuditStore
  readonly jobs: JobService
  readonly ingestion: LocalNativeCandidateIngestion
}

/** Durable candidate → recall → human decision → publication assembly for the configured SQL source. */
export function createLocalCandidateLifecycle(input: {
  readonly database: ControlPostgresDatabase
  readonly sql: LocalOperatorSqlProfile
  readonly documents: LocalDocumentCapability
  readonly definition: SemanticDefinitionVersion
  readonly budget: BudgetLedgerPort
}): LocalCandidateLifecycle {
  const candidates = new PostgresCandidateStore(input.database)
  const identity = new PostgresIdentityDecisionStore(input.database)
  const semanticPublications = new PostgresSemanticPublicationStore(input.database)
  const schemaSource = new PostgresIndustrySchemaSource(input.database)
  const jobs = new JobService({ store: new PostgresJobStore(input.database) })
  const reader = new StructuredIdentityIndexReader({
    query: input.sql.query,
    catalog: input.sql.query,
    mappings: input.sql.mappings,
    profile: input.sql.identityIndexProfile,
    compileBudget: { maxRows: input.sql.maxRows, maxBytes: 262_144, maxJoinFanout: 1 },
    consistency: 'repeatable_read',
  })
  return {
    candidates,
    decisions: new IdentityDecisionService({ store: identity, candidates, schemaSource }),
    publications: new SemanticPublicationService({ store: semanticPublications, candidates, schemaSource, identity }),
    recall: new EntityCandidateRecallService({ schemaSource, index: reader }),
    recallAudits: new PostgresIdentityRecallAuditStore(input.database),
    jobs,
    ingestion: new LocalNativeCandidateIngestion({ jobs, jobStore: new PostgresJobStore(input.database), candidates, parseStore: input.documents.parseStore, definition: input.definition, budget: input.budget }),
  }
}
