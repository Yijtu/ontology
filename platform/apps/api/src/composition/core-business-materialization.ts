import { WorkflowControllerError, canonicalJson } from '@ontology/application'
import type { OutboxConsumer } from '@ontology/application'
import { assertProjectFactInputShape, isUuid } from '@ontology/contracts'
import type { CandidateStore, IdentityDecisionStore, JobStore, OutboxMessageRecord, ProjectStore, ScopeRef, SemanticPublicationStore, ToolContext } from '@ontology/contracts'

/** Route actual private CQ events away from the global business projection and sequence. */
export function createBusinessMaterializationConsumer(options: {
  readonly inner: OutboxConsumer & { readonly topics: readonly string[] }
  readonly publications: Pick<SemanticPublicationStore, 'getPublication' | 'getStatement'>
  readonly projects: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly candidates: Pick<CandidateStore, 'getCandidate'>
  readonly identity: IdentityDecisionStore
}): OutboxConsumer & { readonly topics: readonly string[] } {
  function invalid(message: string): never { throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', message) }
  return { topics: options.inner.topics, consume: async (message: OutboxMessageRecord, ctx: ToolContext) => {
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const modes = new Set<'business' | 'synthetic_validation'>(), projects = new Set<string>(), checked = new Set<string>()
    const projectMode = async (projectId: string, revision?: string) => {
      if (!isUuid(projectId)) invalid('materialization event has an invalid stored project identity')
      projects.add(projectId)
      if (projects.size > 32) invalid('one materialization event exceeds its finite project-purpose bound')
      const key = `${projectId}:${revision ?? 'current'}`
      if (checked.has(key)) return
      const head = await options.projects.getProject(scope, projectId, ctx)
      const stored = head === undefined ? undefined : await options.projects.getRevision(scope, projectId, revision ?? head.activeRevision ?? head.headRevision, ctx)
      if (stored === undefined) invalid('the actual materialization source project is unavailable')
      modes.add(stored.executionPurpose === 'synthetic_validation' ? 'synthetic_validation' : 'business')
      checked.add(key)
    }
    const provenanceMode = async (value: unknown) => {
      if (value === undefined) { modes.add('business'); return }
      assertProjectFactInputShape(value)
      for (const source of value.sources) await projectMode(source.projectRevisionRef.projectId, source.projectRevisionRef.revision)
    }
    const payload = message.payload
    if (message.topic === 'semantic.publication.published') {
      const id = payload['publicationId']
      if (!isUuid(id)) invalid('materialization publication ID is malformed')
      const publication = await options.publications.getPublication(scope, id, ctx)
      if (publication === undefined || publication.outboxId !== message.outboxId || publication.statements.length + publication.ruleVersions.length > 100_000) invalid('materialization event does not name its actual bounded immutable publication')
      for (const statement of publication.statements) await provenanceMode(statement.value['provenance'])
      for (const rule of publication.ruleVersions) {
        if (rule.projectId === undefined) modes.add('business')
        else await projectMode(rule.projectId)
      }
    } else if (message.topic === 'semantic.statement.corrected' || message.topic === 'semantic.statement.retracted') {
      const id = payload['statementId']
      if (!isUuid(id)) invalid('materialization statement ID is malformed')
      const statement = await options.publications.getStatement(scope, id, ctx)
      if (statement === undefined) invalid('materialization statement is not visible in this scope')
      await provenanceMode(statement.value['provenance'])
    } else if (message.topic === 'identity.decision.split') {
      const id = payload['decisionId']
      if (!isUuid(id) || options.identity.getDecisionById === undefined) invalid('materialization split requires its exact immutable scoped decision reader')
      const decision = await options.identity.getDecisionById(scope, id, ctx)
      if (decision?.kind !== 'split' || decision.invalidationOutboxId !== message.outboxId || decision.targetEntityId !== payload['entityId'] || canonicalJson(decision.separatedCandidateIds) !== canonicalJson(payload['separatedCandidateIds']) || (decision.separatedCandidateIds?.length ?? 0) > 256) invalid('the split event differs from its actual immutable decision')
      for (const candidateId of decision.separatedCandidateIds ?? []) {
        const candidate = await options.candidates.getCandidate(scope, candidateId, ctx)
        if (candidate?.kind !== 'entity') invalid('the actual split source candidate is unavailable')
        await provenanceMode(candidate.inputVersion.projectFact)
      }
    } else if (message.topic !== 'semantic.materialization.requested') invalid('this consumer received an unowned event topic')
    if (modes.size > 1) invalid('a materialization event cannot mix private synthetic and ordinary business source ownership')
    if (modes.has('synthetic_validation')) return
    // The actual CQ producer already writes its own namespaced projection. Acknowledging
    // this persisted event neither advances the global watermark nor closes a business fence.
    await options.inner.consume(message, ctx)
  } }
}

/** The persisted private project creation receipt schedules no ordinary business work. */
export function createCompetencyPreviewOutboxConsumer(options: {
  readonly projects: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly jobs: Pick<JobStore, 'getJob'>
}): OutboxConsumer & { readonly topics: readonly string[] } {
  return { topics: ['competency.preview.created'], consume: async (message, ctx) => {
    const projectId = message.payload['projectId'], scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    if (message.topic !== 'competency.preview.created' || !isUuid(projectId)) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the private creation receipt is malformed')
    const project = await options.projects.getProject(scope, projectId, ctx)
    const revision = project === undefined ? undefined : await options.projects.getRevision(scope, projectId, '1', ctx)
    const job = await options.jobs.getJob(scope, message.jobId, ctx)
    if (revision?.executionPurpose !== 'synthetic_validation' || job?.kind !== 'dataset_materialization' || job.sourceRef !== revision.documentSetRef.id || job.datasetRef !== revision.documentSetRef.id) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED', 'the creation receipt does not bind its actual private project and source job')
  } }
}
