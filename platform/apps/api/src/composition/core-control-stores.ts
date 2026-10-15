import {
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresComponentRegistryStore,
  PostgresDecisionStateReferenceStore,
  PostgresDefinitionEditingStore,
  PostgresEvidenceStore,
  PostgresIdentityDecisionStore,
  PostgresIndustryValidationReportStore,
  PostgresInstanceReviewStore,
  PostgresJobStore,
  PostgresMaterializationStore,
  PostgresProfileStore,
  PostgresProjectDocumentStore,
  PostgresProjectMappingStore,
  PostgresProjectReadinessStore,
  PostgresProjectRecordStore,
  PostgresProjectStore,
  PostgresPublishedPackAssetStore,
  PostgresPublishedTaskBindingStore,
  PostgresRuleActionCandidateStore,
  PostgresRuleActionGenerationStore,
  PostgresRunExecutionBindingStore,
  PostgresRunStore,
  PostgresSemanticDefinitionStore,
  PostgresSemanticPublicationStore,
  PostgresSyntheticExampleSetStore,
  PostgresTaskFinalizationReceiptStore,
  PostgresTaskInputSnapshotStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
} from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { PublishedRuleDeclarationReader, ScopedArtifactReader } from '@ontology/contracts'
import { BudgetService } from '@ontology/core'
import { InvalidRequestFieldError } from '../http/shared'
import { CoreCapabilityError } from './core-errors'
import { PostgresCorePlanReceiptStore } from './core-plan-receipts'

/**
 * Every control-plane store the Core local assembly mounts, in one place. They share one pooled
 * `ControlPostgresDatabase` and the object store's scoped reader; nothing here reaches a domain
 * service, so a later phase can consume the returned records without a cycle.
 */
export function createCoreControlStores(database: ControlPostgresDatabase, blobStore: LocalImmutableBlobStore) {
  const scopedOriginals: ScopedArtifactReader = { read: (request, ctx) => {
    const target = request.approvedInputRefs[0]
    if (request.approvedInputRefs.length !== 1 || target === undefined) throw new InvalidRequestFieldError('exactly one scoped immutable reference is required')
    return blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target }, ctx)
  } }
  const control = new ControlPostgresRepository(database)
  const componentStore = new PostgresComponentRegistryStore(database)
  const profileStore = new PostgresProfileStore(database)
  const runStore = new PostgresRunStore(database)
  const jobStore = new PostgresJobStore(database)
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const candidateStore = new PostgresCandidateStore(database)
  const assetCandidateStore = new PostgresAssetCandidateStore(database)
  const ruleActionCandidateStore = new PostgresRuleActionCandidateStore(database)
  const ruleActionGenerationStore = new PostgresRuleActionGenerationStore(database)
  const definitionEditingStore = new PostgresDefinitionEditingStore(database)
  const instanceReviewStore = new PostgresInstanceReviewStore(database)
  const syntheticExampleSetStore = new PostgresSyntheticExampleSetStore(database)
  const validationReportStore = new PostgresIndustryValidationReportStore(database)
  const publishedPackStore = new PostgresPublishedPackAssetStore(database, { competencyBodies: scopedOriginals })
  const projectStore = new PostgresProjectStore(database, { excludeSyntheticValidationProjects: true, requirePublishedInputEvolution: true })
  const projectReadinessStore = new PostgresProjectReadinessStore(database)
  const projectMappingStore = new PostgresProjectMappingStore(database)
  const projectDocumentStore = new PostgresProjectDocumentStore(database)
  const projectRecordStore = new PostgresProjectRecordStore(database)
  const taskBindingStore = new PostgresPublishedTaskBindingStore(database)
  const taskInputSnapshotStore = new PostgresTaskInputSnapshotStore(database)
  const runExecutionBindingStore = new PostgresRunExecutionBindingStore(database)
  const taskFinalizationReceiptStore = new PostgresTaskFinalizationReceiptStore(database)
  const identityStore = new PostgresIdentityDecisionStore(database)
  const publicationStore = new PostgresSemanticPublicationStore(database, { excludeSyntheticValidationProjects: true })
  const definitionStore = new PostgresSemanticDefinitionStore(database)
  const publishedPackRules: { current?: PublishedRuleDeclarationReader } = {}
  const packRuleReader: PublishedRuleDeclarationReader = { read: (...args) => {
    if (publishedPackRules.current === undefined) throw new CoreCapabilityError('the actual published pack rule reader is not initialized')
    return publishedPackRules.current.read(...args)
  } }
  const workflowStore = new PostgresWorkflowStore(database)
  const planReceiptStore = new PostgresCorePlanReceiptStore(database)
  const evidenceStore = new PostgresEvidenceStore(database)
  const materializationStore = new PostgresMaterializationStore(database)
  const decisionStateReferences = new PostgresDecisionStateReferenceStore(database)
  const answerStore = new PostgresAnswerStore(database, { requireWorkflowDispatchFence: true })
  const dispatchStore = new PostgresWorkflowDispatchStore(database)
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(database), control })
  return {
    control, componentStore, profileStore, runStore, jobStore, workspaceStore, candidateStore, assetCandidateStore,
    ruleActionCandidateStore, ruleActionGenerationStore, definitionEditingStore, instanceReviewStore, syntheticExampleSetStore,
    validationReportStore, scopedOriginals, publishedPackStore, projectStore, projectReadinessStore, projectMappingStore,
    projectDocumentStore, projectRecordStore, taskBindingStore, taskInputSnapshotStore, runExecutionBindingStore,
    taskFinalizationReceiptStore, identityStore, publicationStore, definitionStore, publishedPackRules, packRuleReader,
    workflowStore, planReceiptStore, evidenceStore, materializationStore, decisionStateReferences, answerStore, dispatchStore, budget,
  }
}
