import { randomUUID } from 'node:crypto'
import { CompetencyRunner, canonicalJson } from '@ontology/application'
import type { BudgetService } from '@ontology/core'
import { CompetencyQuestionError, createToolContext } from '@ontology/contracts'
import type { CompetencyRunReport, CompetencyValidationTarget, ImmutableArtifactWriter, OperationRegistry, ProfileStore, ResolvedProfile, ScopeRef, ScopedArtifactReader, ToolContext, ToolGateway, VersionRef } from '@ontology/contracts'
import { createCompetencyProjectPreparer } from './competency-project-preparer'
import type { CompetencyProjectPreparerOptions } from './competency-project-preparer'
import { createCoreCompetencyExecution } from './competency-execution'
import type { createCompetencyQuestionWorkflow } from './competency-questions'

/** Normal-host CQ execution uses the same actual registered profile, sources and budget gateway. */
export function createNormalCoreCompetencyExecution(options: Omit<CompetencyProjectPreparerOptions, 'compute'> & {
  readonly questions: ReturnType<typeof createCompetencyQuestionWorkflow>
  readonly profiles: ProfileStore
  readonly budget: BudgetService
  readonly operations: OperationRegistry
  readonly artifacts: ImmutableArtifactWriter
  readonly reader: ScopedArtifactReader
  readonly gateway: (input: { readonly runId: string; readonly ledgerId: string; readonly resolved: ResolvedProfile }, ctx: ToolContext) => ToolGateway
}) {
  const ledgers = new Map<string, Promise<string>>()
  const key = (ctx: ToolContext) => `${ctx.principal.tenantId}:${ctx.allowedResources.spaceId}:${ctx.runId}`
  const prepare = createCompetencyProjectPreparer({ ...options, compute: async (input, ctx, signal) => {
    signal.throwIfAborted()
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const profile = await options.profiles.findResolvedProfile(input.profileRef, input.profileRef.snapshotHash, scope, ctx)
    const operation = options.operations.operations[0]
    if (profile === undefined || operation === undefined || profile.resolved.explicitDegradations.some((item) => item.capability.startsWith('compute:')) ||
      !profile.resolved.computeBindings.some((binding) => binding.operationRef.id === operation.operationRef.id && binding.operationRef.version === operation.operationRef.version && canonicalJson(binding.handlerRef) === canonicalJson(operation.handlerRef) && binding.inputSchemaRef.digest === operation.inputSchemaDigest && binding.outputSchemaRef.digest === operation.outputSchemaDigest)) throw new CompetencyQuestionError('UNKNOWN_PIN', 'the actual registered compute operation is unavailable in this profile')
    const ledgerKey = key(ctx)
    let pending = ledgers.get(ledgerKey)
    if (pending === undefined) {
      if (ledgers.size >= 128) throw new CompetencyQuestionError('FORBIDDEN', 'the bounded competency execution queue is full')
      pending = (async () => { const ledgerId = randomUUID(); await options.budget.openLedger({ ledgerId, kind: 'run', runId: ctx.runId }, ctx); return ledgerId })()
      ledgers.set(ledgerKey, pending)
    }
    const ledgerId = await pending
    const admission = await options.budget.reserve({ ledgerId, idempotencyKey: `cq-host-bind-${input.project.ref.projectId}`, toolCalls: 0, rows: 0, bytes: 0, requestedDeadline: ctx.deadline }, ctx)
    const reservation = admission.reservation
    if (!admission.granted || reservation === undefined) throw new CompetencyQuestionError('FORBIDDEN', 'the actual competency execution budget was refused')
    const metadata = await options.blobs.getAuthorized({ scopeRef: scope, blobRef: input.inputRef }, ctx)
    if (!metadata.integrityVerified || metadata.contentDigest !== input.inputRef.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the scoped registered-operation input is unavailable')
    const context = createToolContext({ ...ctx, resolvedProfileHash: input.profileRef.snapshotHash, deadline: reservation.expiresAt,
      budgetReservation: { reservationId: reservation.reservationId, runId: ctx.runId, grantedAt: reservation.grantedAt, expiresAt: reservation.expiresAt },
      allowedResources: { ...ctx.allowedResources, resourceKinds: [input.inputRef.kind] } })
    signal.throwIfAborted()
    return { gateway: options.gateway({ runId: ctx.runId, ledgerId, resolved: profile.resolved }, context), context, operation }
  } })
  const execution = createCoreCompetencyExecution({ prepare, sources: options.questions.sources, artifacts: options.artifacts, reader: options.reader })
  const runner = new CompetencyRunner({ ...options.questions, questions: options.questions.service, execution })
  return { run: async (ref: VersionRef, ctx: ToolContext, signal: AbortSignal, target?: CompetencyValidationTarget): Promise<CompetencyRunReport> => {
    try { return await runner.run(ref, ctx, signal, target) } finally { ledgers.delete(key(ctx)) }
  } }
}
