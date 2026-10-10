import { canonicalJson, sha256DigestOf, WorkflowControllerError } from '@ontology/application'
import type { ProfileResolver } from '@ontology/application'
import type { IdentityDecisionStore, MaterializationStore, OutboxMessageRecord, ProjectReadinessStore, ProjectRevision, ProjectStore, ScopeRef, SemanticPublicationStore, ToolContext } from '@ontology/contracts'
import type { CoreSemanticTaskResolver } from './core-semantic-task-resolver'
import type { createCoreAuthoring } from './core-authoring'

/** Earn ordinary semantic readiness only after the real business projection has advanced. */
export function createCoreProjectSemanticReadiness(options: {
  readonly projects: ProjectStore; readonly readiness: ProjectReadinessStore; readonly profiles: ProfileResolver
  readonly selectors: Pick<CoreSemanticTaskResolver,'readCurrentInventory'>
  readonly materialization: Pick<MaterializationStore,'getProjectionState' | 'listOpenFences'>
  readonly currentRevisions: (scope: ScopeRef, ctx: ToolContext) => Promise<readonly ProjectRevision[]>
  readonly publications: Pick<SemanticPublicationStore,'latestReadRevision'>
  readonly identity: Pick<IdentityDecisionStore,'latestReadRevision'>
  readonly authoring: ReturnType<typeof createCoreAuthoring>
  readonly now: () => string
}) {
  return async (projectIds: readonly string[],message: OutboxMessageRecord,ctx: ToolContext) => {
    const scope = { tenantId: ctx.principal.tenantId,spaceId: ctx.allowedResources.spaceId }
    const [pending, openFences] = await Promise.all([
      options.materialization.getProjectionState(scope, ctx), options.materialization.listOpenFences(scope, ctx),
    ])
    if (pending === undefined || pending.dirty || pending.watermark.kind !== 'sequence' || openFences.length > 0) return
    // A final child may belong to another publication or arrive after a restart.
    // Read the same durable, bounded project inventory as the materializer rather
    // than relying on the last child's project or an in-memory pending set.
    const currentRevisions = await options.currentRevisions(scope, ctx)
    const affectedProjects = new Set([...projectIds, ...currentRevisions.filter((revision) => revision.executionPurpose !== 'synthetic_validation').map((revision) => revision.ref.projectId)])
    if (affectedProjects.size > 32) throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED','the semantic readiness project inventory exceeds its finite 32-project bound')
    for (const projectId of affectedProjects) {
      const project = await options.projects.getProject(scope,projectId,ctx)
      const revision = project === undefined ? undefined : await options.projects.getRevision(scope,projectId,project.activeRevision ?? project.headRevision,ctx)
      if (project === undefined || project.state === 'archived' || revision === undefined || revision.executionPurpose === 'synthetic_validation') throw new WorkflowControllerError('CAPABILITY_NOT_CONFIGURED','ordinary semantic readiness requires its actual authorized current business project')
      const profile = await options.profiles.getResolvedProfile({ scopeRef: scope,profileRef: revision.profileRef,snapshotHash: revision.profileRef.snapshotHash },ctx)
      let inventory: Awaited<ReturnType<CoreSemanticTaskResolver['readCurrentInventory']>>
      try {
        inventory = await options.selectors.readCurrentInventory(projectId,new Set(profile.resolved.toolBindings.filter((entry) => entry.enabled).map((entry) => entry.toolId)),new Set(profile.resolved.computeBindings.filter((entry) => entry.enabled).map((entry) => `${entry.operationRef.id}@${entry.operationRef.version}`)),ctx)
      } catch (error) {
        if (error instanceof WorkflowControllerError && error.code === 'CAPABILITY_NOT_CONFIGURED') continue
        throw error
      }
      const [state, outstandingFences] = await Promise.all([options.materialization.getProjectionState(scope,ctx),options.materialization.listOpenFences(scope,ctx)])
      if (state === undefined || state.dirty || state.watermark.kind !== 'sequence' || outstandingFences.length > 0 || inventory.source.complete !== true || inventory.source.readRevision === undefined || inventory.source.facts.length === 0 || (inventory.source.ruleIssues?.length ?? 0) > 0 || (inventory.source.attributeIssues?.length ?? 0) > 0) continue
      const body = { schemaVersion: 'project-published-semantics-readiness@1',projectRevisionRef: revision.ref,definitionRef: revision.definitionRef,
        industryPackRef: revision.industryPackRef,sourceReadRevision: inventory.source.readRevision,projection: state,
        sourceDigest: sha256DigestOf(canonicalJson({ facts: inventory.source.facts,rules: inventory.source.rules,declarations: inventory.declarations })),expectedFacts: inventory.source.facts.length,outboxId: message.outboxId }
      const digest = sha256DigestOf(canonicalJson(body))
      const receipt = await options.authoring.stableWrite(`project-semantic-readiness:${digest}`,new TextEncoder().encode(canonicalJson(body)),'application/json','artifact',ctx)
      const [semantic,identity,current,currentRevision,projection,finalFences] = await Promise.all([options.publications.latestReadRevision(scope,ctx),options.identity.latestReadRevision(scope,ctx),options.projects.getProject(scope,projectId,ctx),options.projects.getRevision(scope,projectId,revision.ref.revision,ctx),options.materialization.getProjectionState(scope,ctx),options.materialization.listOpenFences(scope,ctx)])
      // A staged head may advance independently while this worker is recording
      // readiness for the still-active revision. Fence the business selector,
      // full immutable revision, source points, and projection that were read.
      const selectedRevision = project.activeRevision ?? project.headRevision
      const currentSelectedRevision = current?.activeRevision ?? current?.headRevision
      if (semantic !== inventory.source.readRevision.semantic || identity !== inventory.source.readRevision.identity || current === undefined || current.state !== project.state || currentSelectedRevision !== selectedRevision || selectedRevision !== revision.ref.revision || canonicalJson(currentRevision) !== canonicalJson(revision) || canonicalJson(projection) !== canonicalJson(state) || finalFences.length > 0) throw new WorkflowControllerError('VERSION_CONFLICT','the actual project semantic source or projection changed during readiness capture')
      // The readiness target is the fixed definition; the independently archived receipt
      // records each actual source/projection point without changing that target's axis.
      await options.readiness.upsertProjection(scope,{ projectRevisionRef: revision.ref,kind: 'published_semantics',targetRef: revision.definitionRef,targetDigest: revision.definitionRef.digest,receiptRef: receipt,
        state: 'ready',completeness: 'complete',expectedCount: inventory.source.facts.length,processedCount: inventory.source.facts.length,failedCount: 0,fenceRevision: revision.ref.revision,
        jobId: message.jobId,idempotencyKey: `project-semantic-readiness:${message.outboxId}:${revision.ref.digest}:${digest}`,requestDigest: digest,actor: ctx.principal.subjectId,recordedAt: options.now() },ctx)
    }
  }
}
